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
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
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
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateJobDto): Promise<JobView> {
    return this.jobs.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the signed-in user\'s jobs, newest first' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListJobsQueryDto): Promise<JobPage> {
    return this.jobs.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Job detail' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<JobView> {
    return this.jobs.get(user, id);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Execution history, oldest first' })
  events(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListEventsQueryDto,
  ) {
    return this.jobs.events(user, id, query);
  }

  @Get(':id/result')
  @ApiOperation({ summary: 'Summary metrics for a finished job' })
  result(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<JobResultView> {
    return this.jobs.result(user, id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download the JSON report' })
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const file = await this.jobs.getReportFile(user, id);
    return new StreamableFile(file.body, {
      type: 'application/json',
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start a new execution of a failed job' })
  retry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<JobView> {
    return this.jobs.retry(user, id);
  }
}
