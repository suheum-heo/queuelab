import { DecimalPipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { JOB_STATUSES, type JobStatus, type JobView } from '@queuelab/shared-types';
import { timer } from 'rxjs';
import { JobApiService } from '../../../core/api/job-api.service';
import { httpErrorMessage } from '../../../core/api/http-error';
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
  private readonly formBuilder = inject(FormBuilder);

  readonly statuses = JOB_STATUSES;
  readonly statusLabel = STATUS_LABELS;
  readonly jobs = signal<JobView[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  private readonly expanded = signal(false);
  private requestId = 0;
  readonly filters = this.formBuilder.nonNullable.group({
    q: '',
    status: 'ALL' as StatusFilter,
  });

  constructor() {
    timer(0, 2000)
      .pipe(takeUntilDestroyed())
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
