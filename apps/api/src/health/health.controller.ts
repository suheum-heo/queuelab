import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Database and Redis connectivity' })
  @ApiOkResponse({
    schema: {
      example: { status: 'ok', service: 'api', checks: { database: 'up', redis: 'up' } },
    },
  })
  async check(): Promise<{
    status: 'ok';
    service: 'api';
    checks: { database: 'up' | 'down'; redis: 'up' | 'down' };
  }> {
    const checks = {
      database: 'down' as 'up' | 'down',
      redis: 'down' as 'up' | 'down',
    };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }

    try {
      await this.queue.ping();
      checks.redis = 'up';
    } catch {
      checks.redis = 'down';
    }

    if (checks.database !== 'up' || checks.redis !== 'up') {
      throw new ServiceUnavailableException({ status: 'degraded', service: 'api', checks });
    }

    return { status: 'ok', service: 'api', checks };
  }
}
