import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MetricsOverview } from '@queuelab/shared-types';
import type { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Counts for the signed-in user' })
  overview(@CurrentUser() user: AuthUser): Promise<MetricsOverview> {
    return this.metrics.overview(user.id);
  }
}
