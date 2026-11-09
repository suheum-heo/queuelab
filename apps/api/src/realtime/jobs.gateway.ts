import { SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import {
  JOB_SUBSCRIBE,
  JOB_UNSUBSCRIBE,
  JOB_UPDATE_EVENT,
  LEDGER_SUBSCRIBE,
  type JobUpdateNotice,
} from '@queuelab/shared-types';
import type { Server, Socket } from 'socket.io';

const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fans out notices. The payload tells the client which row to reread.
 * It is not a copy of the PostgreSQL job.
 */
@WebSocketGateway({
  cors: {
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:4200',
  },
})
export class JobsGateway {
  @WebSocketServer()
  server?: Server;

  emit(notice: JobUpdateNotice): void {
    this.server?.to(`job:${notice.jobId}`).to('jobs').emit(JOB_UPDATE_EVENT, notice);
  }

  @SubscribeMessage(LEDGER_SUBSCRIBE)
  subscribeLedger(client: Socket): { ok: true } {
    client.join('jobs');
    return { ok: true };
  }

  @SubscribeMessage(JOB_SUBSCRIBE)
  subscribeJob(client: Socket, jobId: unknown): { ok: boolean } {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return { ok: false };
    client.join(`job:${jobId}`);
    return { ok: true };
  }

  @SubscribeMessage(JOB_UNSUBSCRIBE)
  unsubscribeJob(client: Socket, jobId: unknown): { ok: true } {
    if (typeof jobId === 'string') client.leave(`job:${jobId}`);
    return { ok: true };
  }
}
