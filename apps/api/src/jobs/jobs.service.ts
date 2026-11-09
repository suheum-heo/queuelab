import {
  BadRequestException,
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
  type CsvAnalysisOptions,
  type JobEventPage,
  type JobPage,
  type JobResultView,
} from '@queuelab/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
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
  ) {}

  /**
   * Insert the row, then enqueue. These are not one transaction.
   * The row stays PENDING_ENQUEUE until BullMQ accepts the job id.
   * A failed enqueue is returned as 503 and is not described as queued.
   * Reconciliation of stranded PENDING_ENQUEUE rows is a later milestone.
   */
  async create(dto: CreateJobDto) {
    if (dto.type !== 'CSV_ANALYSIS') {
      throw new BadRequestException('Only CSV_ANALYSIS is supported');
    }

    const user = await this.demoUser();
    const upload = await this.uploads.require(dto.fileId);
    const options = resolveOptions(dto.options, upload.filename);
    const job = await this.prisma.job.create({
      data: {
        userId: user.id,
        type: 'CSV_ANALYSIS',
        status: 'PENDING_ENQUEUE',
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        inputKey: upload.key,
        options: options as unknown as Prisma.InputJsonValue,
        events: {
          create: {
            eventType: 'CREATED',
            message: 'Job recorded. Enqueue is pending.',
          },
        },
      },
    });

    try {
      await this.queue.enqueueCsvAnalysis({
        jobId: job.id,
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
      throw new ServiceUnavailableException({
        message: 'The job was saved but the queue did not accept it. It was not marked queued.',
        id: job.id,
        status: 'PENDING_ENQUEUE',
        progress: 0,
        createdAt: job.createdAt.toISOString(),
      });
    }

    const queued = await this.prisma.job.update({
      where: { id: job.id },
      data: { status: 'QUEUED' },
    });
    await this.prisma.jobEvent.create({
      data: {
        jobId: job.id,
        eventType: 'QUEUED',
        message: 'Accepted by BullMQ',
      },
    });
    return presentJob(queued);
  }

  async list(query: ListJobsQueryDto): Promise<JobPage> {
    const limit = query.limit ?? 20;
    const cursor = this.readCursor(query.cursor);
    const where: Prisma.JobWhereInput = {
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

  async get(id: string) {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    return presentJob(job);
  }

  async events(id: string, query: ListEventsQueryDto): Promise<JobEventPage> {
    await this.get(id);
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

  async result(id: string): Promise<JobResultView> {
    await this.get(id);
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

  async getReportFile(id: string): Promise<{ filename: string; body: Buffer }> {
    const job = await this.prisma.job.findUnique({
      where: { id },
      include: { result: true },
    });
    if (!job?.result) throw new NotFoundException('Report not found');

    const key = `results/${job.id}.json`;
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

  private demoUser(): Promise<{ id: string }> {
    const email = process.env.DEMO_USER_EMAIL ?? 'demo@queuelab.dev';
    return this.prisma.user.upsert({
      where: { email },
      update: {},
      create: { email },
    });
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
  };
}
