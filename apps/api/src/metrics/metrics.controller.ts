import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MetricsOverview } from '@queuelab/shared-types';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Counts for the dashboard' })
  overview(): Promise<MetricsOverview> {
    return this.metrics.overview();
  }
}
