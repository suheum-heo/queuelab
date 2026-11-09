import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { type AnalysisReport, type JobEventView, type JobResultView, type JobView } from '@queuelab/shared-types';
import { EMPTY, asyncScheduler, forkJoin, merge, of, timer } from 'rxjs';
import { catchError, filter, finalize, map, switchMap, tap, throttleTime } from 'rxjs/operators';
import { httpErrorMessage } from '../../../core/api/http-error';
import { JobApiService } from '../../../core/api/job-api.service';
import { JobRealtimeService } from '../../../core/realtime/job-realtime.service';
import { ProgressBarComponent } from '../../../shared/components/progress-bar.component';
import { StatusBadgeComponent } from '../../../shared/components/status-badge.component';

@Component({
  selector: 'app-job-detail',
  imports: [RouterLink, DatePipe, DecimalPipe, StatusBadgeComponent, ProgressBarComponent],
  templateUrl: './job-detail.component.html',
})
export class JobDetailComponent {
  private readonly api = inject(JobApiService);
  private readonly realtime = inject(JobRealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly connected$ = toObservable(this.realtime.connected);

  readonly job = signal<JobView | null>(null);
  readonly events = signal<JobEventView[]>([]);
  readonly result = signal<JobResultView | null>(null);
  readonly error = signal<string | null>(null);
  readonly live = computed(() => (this.realtime.connected() ? 'Live' : 'Reconnecting'));
  readonly retrying = signal(false);
  readonly canRetry = computed(() => this.job()?.status === 'FAILED' && this.job()?.seeded === false);
  readonly report = computed(() => readReport(this.result()?.summary));

  constructor() {
    this.route.paramMap
      .pipe(
        map((params) => params.get('id')),
        filter((id): id is string => Boolean(id)),
        switchMap((id) => this.watch(id)),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

  retry(): void {
    const id = this.job()?.id;
    if (!id || !this.canRetry() || this.retrying()) return;
    this.retrying.set(true);
    this.error.set(null);
    this.api.retry(id).subscribe({
      next: (job) => {
        this.job.set(job);
        this.retrying.set(false);
      },
      error: (error: unknown) => {
        this.error.set(httpErrorMessage(error));
        this.retrying.set(false);
      },
    });
  }

  private watch(id: string) {
    this.job.set(null);
    this.events.set([]);
    this.result.set(null);
    this.error.set(null);
    const stop = this.realtime.watchJob(id);

    return merge(
      of(undefined),
      this.realtime.notices().pipe(filter((notice) => notice.jobId === id)),
      this.realtime.reconnected(),
      this.connected$.pipe(switchMap((connected) => (connected ? EMPTY : timer(2_000, 2_000)))),
    ).pipe(
      throttleTime(200, asyncScheduler, { leading: true, trailing: true }),
      switchMap(() => this.load(id)),
      finalize(() => stop()),
    );
  }

  private load(id: string) {
    return this.api.get(id).pipe(
      switchMap((job) =>
        forkJoin({
          job: of(job),
          events: this.api.events(id),
          result:
            job.status === 'COMPLETED'
              ? this.api.result(id).pipe(catchError(() => of(null)))
              : of(null),
        }),
      ),
      tap(({ job, events, result }) => {
        this.job.set(job);
        this.events.set(events.items);
        this.result.set(result);
        this.error.set(null);
      }),
      catchError((error: unknown) => {
        this.error.set(httpErrorMessage(error));
        return EMPTY;
      }),
    );
  }
}

function readReport(summary: unknown): AnalysisReport | null {
  if (!summary || typeof summary !== 'object' || !('totals' in summary) || !('averages' in summary)) {
    return null;
  }
  return summary as AnalysisReport;
}
