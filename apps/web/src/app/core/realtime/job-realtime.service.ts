import { Injectable, signal } from '@angular/core';
import {
  JOB_SUBSCRIBE,
  JOB_UNSUBSCRIBE,
  JOB_UPDATE_EVENT,
  LEDGER_SUBSCRIBE,
  readJobUpdateNotice,
  type JobUpdateNotice,
} from '@queuelab/shared-types';
import { Observable, Subject } from 'rxjs';
import { io, type Socket } from 'socket.io-client';

@Injectable({ providedIn: 'root' })
export class JobRealtimeService {
  readonly connected = signal(false);

  private socket: Socket | null = null;
  private readonly noticeSubject = new Subject<JobUpdateNotice>();
  private readonly reconnectSubject = new Subject<void>();
  private readonly jobs = new Map<string, number>();
  private ledgerListeners = 0;

  notices(): Observable<JobUpdateNotice> {
    this.ensure();
    return this.noticeSubject.asObservable();
  }

  /** Fires after the socket connects and rooms have been joined again. */
  reconnected(): Observable<void> {
    this.ensure();
    return this.reconnectSubject.asObservable();
  }

  watchLedger(): () => void {
    this.ensure();
    this.ledgerListeners += 1;
    if (this.socket?.connected) this.socket.emit(LEDGER_SUBSCRIBE);
    return () => {
      this.ledgerListeners = Math.max(0, this.ledgerListeners - 1);
    };
  }

  watchJob(jobId: string): () => void {
    this.ensure();
    this.jobs.set(jobId, (this.jobs.get(jobId) ?? 0) + 1);
    if (this.socket?.connected) this.socket.emit(JOB_SUBSCRIBE, jobId);
    return () => {
      const remaining = (this.jobs.get(jobId) ?? 1) - 1;
      if (remaining <= 0) {
        this.jobs.delete(jobId);
        this.socket?.emit(JOB_UNSUBSCRIBE, jobId);
      } else {
        this.jobs.set(jobId, remaining);
      }
    };
  }

  private ensure(): void {
    if (this.socket) return;
    this.socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    this.socket.on('connect', () => {
      this.resubscribe();
      this.connected.set(true);
      this.reconnectSubject.next();
    });
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on(JOB_UPDATE_EVENT, (payload: unknown) => {
      const notice = readJobUpdateNotice(payload);
      if (notice) this.noticeSubject.next(notice);
    });
  }

  private resubscribe(): void {
    if (!this.socket) return;
    if (this.ledgerListeners > 0) this.socket.emit(LEDGER_SUBSCRIBE);
    for (const jobId of this.jobs.keys()) {
      this.socket.emit(JOB_SUBSCRIBE, jobId);
    }
  }
}
