import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@queuelab/database';
import {
  DEFAULT_MAX_ATTEMPTS,
  decodeCursor,
  encodeCursor,
  isSeededJob,
  isStoredReportKey,
  type CsvAnalysisOptions,
  type DemoFailure,
  type JobEventPage,
  type JobPage,
  type JobResultView,
} from '@queuelab/shared-types';
import type { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { JobUpdatesService } from '../realtime/job-updates.service';
import { StorageService } from '../storage/storage.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateJobDto } from './dto/create-job.dto';
import { ListEventsQueryDto, ListJobsQueryDto } from './dto/list-jobs.query';
import { presentJob } from './job.presenter';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly storage: StorageService,
    private readonly uploads: UploadsService,
    private readonly updates: JobUpdatesService,
  ) {}

  /**
   * Insert the row, then enqueue. These are not one transaction.
   * The row stays PENDING_ENQUEUE until BullMQ accepts the job id.
   * A failed enqueue is returned as 503 and is not described as queued.
   * The reconciler later claims the same execution id and tries Redis again.
   */
  async create(user: AuthUser, dto: CreateJobDto) {
    if (dto.type !== 'CSV_ANALYSIS') {
      throw new BadRequestException('Only CSV_ANALYSIS is supported');
    }

    const upload = await this.uploads.require(dto.fileId, user.id);
    const options = resolveOptions(dto.options, upload.filename);
    const executionId = randomUUID();
    const job = await this.prisma.job.create({
      data: {
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'PENDING_ENQUEUE',
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        inputKey: upload.key,
        executionNumber: 1,
        currentExecutionId: executionId,
        options: options as unknown as Prisma.InputJsonValue,
        executions: {
          create: {
            id: executionId,
            number: 1,
            status: 'PENDING_ENQUEUE',
          },
        },
        events: {
          create: {
            eventType: 'CREATED',
            message: 'Job recorded. Enqueue of execution 1 is pending.',
            metadata: { executionId, executionNumber: 1 },
          },
        },
      },
    });

    try {
      await this.queue.enqueueCsvAnalysis({
        jobId: job.id,
        executionId,
        fileKey: upload.key,
        options,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Enqueue failed for ${job.id}: ${reason}`);
      await this.prisma.jobEvent.create({
        data: {
          jobId: job.id,
          eventType: 'ENQUEUE_FAILED',
          message: 'BullMQ did not accept the job. Status left at PENDING_ENQUEUE.',
          metadata: { reason },
        },
      });
      await this.publish(job.id, 'ENQUEUE_FAILED');
      throw new ServiceUnavailableException({
        message: 'The job was saved but the queue did not accept it. It was not marked queued.',
        id: job.id,
        status: 'PENDING_ENQUEUE',
        progress: 0,
        createdAt: job.createdAt.toISOString(),
      });
    }

    await this.prisma.jobExecution.update({
      where: { id: executionId },
      data: { status: 'QUEUED' },
    });
    const queued = await this.prisma.job.update({
      where: { id: job.id },
      data: { status: 'QUEUED' },
    });
    await this.prisma.jobEvent.create({
      data: {
        jobId: job.id,
        eventType: 'QUEUED',
        message: 'Execution 1 was accepted by BullMQ.',
        metadata: { executionId, executionNumber: 1 },
      },
    });
    await this.publish(job.id, 'QUEUED');
    return presentJob(queued);
  }

  /**
   * Starts a new execution of a failed job. Automatic BullMQ retries stay
   * inside one execution and reuse its queue id. The claim is a conditional
   * update, so two overlapping requests cannot both create an execution.
   */
  async retry(user: AuthUser, id: string) {
    const existing = await this.prisma.job.findFirst({ where: { id, userId: user.id } });
    if (!existing) throw new NotFoundException('Job not found');
    if (isSeededJob(existing.options)) {
      throw new BadRequestException('Sample jobs are not queued and cannot be retried.');
    }
    if (existing.status !== 'FAILED') {
      throw new ConflictException('Only a failed job can be retried.');
    }
    if (!existing.inputKey) {
      throw new BadRequestException('This job has no stored CSV to read again.');
    }

    const options = readStoredOptions(existing.options);
    const executionId = randomUUID();
    const executionNumber = existing.executionNumber + 1;
    const claimed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.job.updateMany({
        where: { id, userId: user.id, status: 'FAILED' },
        data: {
          status: 'PENDING_ENQUEUE',
          progress: 0,
          attempts: 0,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          resultKey: null,
          executionNumber,
          currentExecutionId: executionId,
        },
      });
      if (updated.count !== 1) return false;
      await tx.jobExecution.create({
        data: {
          id: executionId,
          jobId: id,
          number: executionNumber,
          status: 'PENDING_ENQUEUE',
        },
      });
      await tx.jobEvent.create({
        data: {
          jobId: id,
          eventType: 'RETRY_REQUESTED',
          message: `Manual retry started execution ${executionNumber}. Earlier attempts stay in this history.`,
          metadata: { executionId, executionNumber },
        },
      });
      return true;
    });
    if (!claimed) {
      throw new ConflictException('A retry for this job was already claimed.');
    }

    try {
      await this.queue.enqueueCsvAnalysis({
        jobId: id,
        executionId,
        fileKey: existing.inputKey,
        options,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Retry enqueue failed for ${id}: ${reason}`);
      await this.prisma.jobEvent.create({
        data: {
          jobId: id,
          eventType: 'ENQUEUE_FAILED',
          message: `Execution ${executionNumber} was saved but BullMQ did not accept it.`,
          metadata: { reason, executionId, executionNumber },
        },
      });
      await this.publish(id, 'ENQUEUE_FAILED');
      throw new ServiceUnavailableException({
        message: 'The retry was saved but the queue did not accept it. It was not marked queued.',
        id,
        status: 'PENDING_ENQUEUE',
        executionNumber,
      });
    }

    await this.prisma.jobExecution.update({
      where: { id: executionId },
      data: { status: 'QUEUED' },
    });
    const queued = await this.prisma.job.update({
      where: { id },
      data: { status: 'QUEUED' },
    });
    await this.prisma.jobEvent.create({
      data: {
        jobId: id,
        eventType: 'QUEUED',
        message: `Execution ${executionNumber} was accepted by BullMQ.`,
        metadata: { executionId, executionNumber },
      },
    });
    await this.publish(id, 'QUEUED');
    return presentJob(queued);
  }

  async list(user: AuthUser, query: ListJobsQueryDto): Promise<JobPage> {
    const limit = query.limit ?? 20;
    const cursor = this.readCursor(query.cursor);
    const where: Prisma.JobWhereInput = {
      userId: user.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { inputKey: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.job.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((job) => presentJob(job)),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async get(user: AuthUser, id: string) {
    const job = await this.prisma.job.findFirst({ where: { id, userId: user.id } });
    if (!job) throw new NotFoundException('Job not found');
    return presentJob(job);
  }

  async events(user: AuthUser, id: string, query: ListEventsQueryDto): Promise<JobEventPage> {
    await this.get(user, id);
    const limit = query.limit ?? 50;
    const cursor = this.readCursor(query.cursor);
    const rows = await this.prisma.jobEvent.findMany({
      where: {
        jobId: id,
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((event) => ({
        id: event.id,
        jobId: event.jobId,
        eventType: event.eventType,
        message: event.message,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async result(user: AuthUser, id: string): Promise<JobResultView> {
    await this.get(user, id);
    const result = await this.prisma.jobResult.findUnique({ where: { jobId: id } });
    if (!result) throw new NotFoundException('Result not found');
    return {
      id: result.id,
      jobId: result.jobId,
      totalRows: result.totalRows,
      validRows: result.validRows,
      invalidRows: result.invalidRows,
      summary: result.summary,
      createdAt: result.createdAt.toISOString(),
    };
  }

  async getReportFile(user: AuthUser, id: string): Promise<{ filename: string; body: Buffer }> {
    const job = await this.prisma.job.findFirst({
      where: { id, userId: user.id },
      include: { result: true },
    });
    if (!job?.result) throw new NotFoundException('Report not found');

    const key =
      job.resultKey && isStoredReportKey(job.resultKey) ? job.resultKey : `results/${job.id}.json`;
    const filename = `report-${job.id}.json`;
    try {
      return { filename, body: await this.storage.read(key) };
    } catch {
      const body = Buffer.from(JSON.stringify(job.result.summary, null, 2));
      await this.storage.write(key, body);
      return { filename, body };
    }
  }

  private readCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
    if (!cursor) return undefined;
    try {
      return decodeCursor(cursor);
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }

  private async publish(jobId: string, eventType: string): Promise<void> {
    try {
      await this.updates.publish(jobId, eventType);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Job ${jobId} was saved, but the live notice was not published: ${reason}`);
    }
  }

}

const DELIMITERS: Record<string, string> = {
  ',': ',',
  ';': ';',
  '|': '|',
  tab: '\t',
  '\t': '\t',
};

function resolveOptions(input: CreateJobDto['options'], filename: string): CsvAnalysisOptions {
  const delimiter = DELIMITERS[input?.delimiter ?? ','];
  if (!delimiter) {
    throw new BadRequestException('Delimiter must be a comma, semicolon, pipe, or tab');
  }
  return {
    delimiter,
    hasHeader: input?.hasHeader ?? true,
    filename,
    ...(input?.demoFailure ? { demoFailure: input.demoFailure } : {}),
  };
}

function readStoredOptions(value: unknown): CsvAnalysisOptions {
  if (!value || typeof value !== 'object') {
    throw new BadRequestException('Job options are missing.');
  }
  const record = value as Partial<CsvAnalysisOptions>;
  if (typeof record.delimiter !== 'string' || typeof record.filename !== 'string') {
    throw new BadRequestException('Job options are incomplete.');
  }
  const demoFailure = isDemoFailure(record.demoFailure) ? record.demoFailure : undefined;
  return {
    delimiter: record.delimiter,
    hasHeader: record.hasHeader ?? true,
    filename: record.filename,
    ...(record.seeded ? { seeded: true } : {}),
    ...(demoFailure ? { demoFailure } : {}),
  };
}

function isDemoFailure(value: unknown): value is DemoFailure {
  return value === 'transient' || value === 'exhaust-first-execution';
}
