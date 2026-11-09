import { ApiPropertyOptional } from '@nestjs/swagger';
import { JOB_STATUSES, type JobStatus } from '@queuelab/shared-types';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListJobsQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned as nextCursor' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: JOB_STATUSES })
  @IsOptional()
  @IsIn(JOB_STATUSES)
  status?: JobStatus;

  @ApiPropertyOptional({ description: 'Case-insensitive match against the storage key' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class ListEventsQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;
}
