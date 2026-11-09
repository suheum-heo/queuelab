import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { JobPage, JobResultView, JobView } from '@queuelab/shared-types';
import { CreateJobDto } from './dto/create-job.dto';
import { ListEventsQueryDto, ListJobsQueryDto } from './dto/list-jobs.query';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Create a job and enqueue it when Redis accepts it' })
  @ApiAcceptedResponse({ description: 'Job is queued, or pending if enqueue failed with 503' })
  create(@Body() dto: CreateJobDto): Promise<JobView> {
    return this.jobs.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List jobs, newest first, with cursor pagination' })
  list(@Query() query: ListJobsQueryDto): Promise<JobPage> {
    return this.jobs.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Job detail' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<JobView> {
    return this.jobs.get(id);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Execution history, oldest first' })
  events(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListEventsQueryDto) {
    return this.jobs.events(id, query);
  }

  @Get(':id/result')
  @ApiOperation({ summary: 'Summary metrics for a finished job' })
  result(@Param('id', ParseUUIDPipe) id: string): Promise<JobResultView> {
    return this.jobs.result(id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download the JSON report' })
  async download(@Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const file = await this.jobs.getReportFile(id);
    return new StreamableFile(file.body, {
      type: 'application/json',
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start a new execution of a failed job' })
  retry(@Param('id', ParseUUIDPipe) id: string): Promise<JobView> {
    return this.jobs.retry(id);
  }
}
