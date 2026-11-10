import { Logger } from '@nestjs/common';
import {
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  JOB_SUBSCRIBE,
  JOB_UNSUBSCRIBE,
  JOB_UPDATE_EVENT,
  LEDGER_SUBSCRIBE,
  type JobUpdateNotice,
} from '@queuelab/shared-types';
import type { Server, Socket } from 'socket.io';
import { readBearer, readCookie, sessionCookieName } from '../auth/cookies';
import { TokenService } from '../auth/token.service';
import { PrismaService } from '../prisma/prisma.service';

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fans out notices to the job's owner. The payload tells that client which
 * row to reread. Joining a room requires the same user that owns the row.
 */
@WebSocketGateway({
  cors: {
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:4200',
    credentials: true,
  },
})
export class JobsGateway implements OnGatewayInit {
  private readonly logger = new Logger(JobsGateway.name);

  @WebSocketServer()
  server?: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Server): void {
    server.use(async (socket, next) => {
      try {
        const user = await this.tokens.authenticate(tokenFrom(socket));
        if (!user) {
          next(new Error('unauthorized'));
          return;
        }
        (socket.data as { userId?: string }).userId = user.id;
        next();
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`Socket sign-in failed: ${reason}`);
        next(new Error('unauthorized'));
      }
    });
  }

  async emit(notice: JobUpdateNotice): Promise<void> {
    try {
      const job = await this.prisma.job.findUnique({
        where: { id: notice.jobId },
        select: { userId: true },
      });
      if (!job || !this.server) return;
      this.server.to(`job:${notice.jobId}`).to(`user:${job.userId}`).emit(JOB_UPDATE_EVENT, notice);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Job notice for ${notice.jobId} was not sent: ${reason}`);
    }
  }

  @SubscribeMessage(LEDGER_SUBSCRIBE)
  subscribeLedger(client: Socket): { ok: true } {
    const userId = userIdOf(client);
    if (userId) client.join(`user:${userId}`);
    return { ok: true };
  }

  @SubscribeMessage(JOB_SUBSCRIBE)
  async subscribeJob(client: Socket, jobId: unknown): Promise<{ ok: boolean }> {
    const userId = userIdOf(client);
    if (!userId || typeof jobId !== 'string' || !JOB_ID.test(jobId)) return { ok: false };
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, userId },
      select: { id: true },
    });
    if (!job) return { ok: false };
    await client.join(`job:${jobId}`);
    return { ok: true };
  }

  @SubscribeMessage(JOB_UNSUBSCRIBE)
  unsubscribeJob(client: Socket, jobId: unknown): { ok: true } {
    if (typeof jobId === 'string') client.leave(`job:${jobId}`);
    return { ok: true };
  }
}

function tokenFrom(socket: Socket): string | undefined {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
  const header = socket.handshake.headers.authorization;
  const bearer = readBearer(Array.isArray(header) ? header[0] : header);
  if (bearer) return bearer;
  const cookie = socket.handshake.headers.cookie;
  return readCookie(Array.isArray(cookie) ? cookie[0] : cookie, sessionCookieName());
}

function userIdOf(socket: Socket): string | null {
  const id = (socket.data as { userId?: unknown }).userId;
  return typeof id === 'string' ? id : null;
}
