import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { JOB_STATUSES, type JobStatus, type JobView } from '@queuelab/shared-types';
import { EMPTY, asyncScheduler, merge, of, timer } from 'rxjs';
import { finalize, switchMap, throttleTime } from 'rxjs/operators';
import { JobApiService } from '../../../core/api/job-api.service';
import { httpErrorMessage } from '../../../core/api/http-error';
import { JobRealtimeService } from '../../../core/realtime/job-realtime.service';
import { ProgressBarComponent } from '../../../shared/components/progress-bar.component';
import { StatusBadgeComponent } from '../../../shared/components/status-badge.component';

type StatusFilter = 'ALL' | JobStatus;

const STATUS_LABELS: Record<JobStatus, string> = {
  PENDING_ENQUEUE: 'Pending',
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  RETRYING: 'Retrying',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

@Component({
  selector: 'app-job-list',
  imports: [ReactiveFormsModule, RouterLink, DecimalPipe, StatusBadgeComponent, ProgressBarComponent],
  templateUrl: './job-list.component.html',
})
export class JobListComponent {
  private readonly api = inject(JobApiService);
  private readonly realtime = inject(JobRealtimeService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly connected$ = toObservable(this.realtime.connected);

  readonly statuses = JOB_STATUSES;
  readonly statusLabel = STATUS_LABELS;
  readonly jobs = signal<JobView[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly live = computed(() => (this.realtime.connected() ? 'Live' : 'Reconnecting'));
  private readonly expanded = signal(false);
  private requestId = 0;
  readonly filters = this.formBuilder.nonNullable.group({
    q: '',
    status: 'ALL' as StatusFilter,
  });

  constructor() {
    const stop = this.realtime.watchLedger();
    merge(
      of(undefined),
      this.realtime.notices(),
      this.realtime.reconnected(),
      this.connected$.pipe(switchMap((connected) => (connected ? EMPTY : timer(2_000, 2_000)))),
    )
      .pipe(
        throttleTime(200, asyncScheduler, { leading: true, trailing: true }),
        finalize(() => stop()),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (!this.expanded()) this.fetch(false);
      });
  }

  setStatus(status: StatusFilter): void {
    this.filters.controls.status.setValue(status);
    this.expanded.set(false);
    this.fetch(false);
  }

  search(): void {
    this.expanded.set(false);
    this.fetch(false);
  }

  loadMore(): void {
    const cursor = this.nextCursor();
    if (!cursor) return;
    this.expanded.set(true);
    this.fetch(true);
  }

  backToLatest(): void {
    this.expanded.set(false);
    this.fetch(false);
  }

  private fetch(append: boolean): void {
    const requestId = ++this.requestId;
    const { q, status } = this.filters.getRawValue();
    this.loading.set(true);
    this.api
      .list({
        limit: 20,
        cursor: append ? this.nextCursor() : null,
        status: status === 'ALL' ? undefined : status,
        q: q.trim() || undefined,
      })
      .subscribe({
        next: (page) => {
          if (requestId !== this.requestId) return;
          this.jobs.set(append ? [...this.jobs(), ...page.items] : page.items);
          this.nextCursor.set(page.nextCursor);
          this.error.set(null);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          if (requestId !== this.requestId) return;
          this.error.set(httpErrorMessage(error));
          this.loading.set(false);
        },
      });
  }
}
