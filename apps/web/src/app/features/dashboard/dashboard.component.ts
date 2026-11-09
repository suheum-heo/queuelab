import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { JobView, MetricsOverview } from '@queuelab/shared-types';
import { EMPTY, asyncScheduler, forkJoin, merge, of, timer } from 'rxjs';
import { catchError, finalize, switchMap, throttleTime } from 'rxjs/operators';
import { httpErrorMessage } from '../../core/api/http-error';
import { JobApiService } from '../../core/api/job-api.service';
import { JobRealtimeService } from '../../core/realtime/job-realtime.service';
import { ProgressBarComponent } from '../../shared/components/progress-bar.component';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, DecimalPipe, StatusBadgeComponent, ProgressBarComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  private readonly api = inject(JobApiService);
  private readonly realtime = inject(JobRealtimeService);
  private readonly connected$ = toObservable(this.realtime.connected);

  readonly metrics = signal<MetricsOverview | null>(null);
  readonly recent = signal<JobView[]>([]);
  readonly error = signal<string | null>(null);
  readonly live = computed(() => (this.realtime.connected() ? 'Live' : 'Reconnecting'));
  readonly processing = computed(() => {
    const metrics = this.metrics();
    if (!metrics) return null;
    return metrics.processing + metrics.retrying;
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
        switchMap(() =>
          forkJoin({
            metrics: this.api.overview(),
            recent: this.api.list({ limit: 6 }),
          }).pipe(
            catchError((error: unknown) => {
              this.error.set(httpErrorMessage(error));
              return of(null);
            }),
          ),
        ),
        finalize(() => stop()),
        takeUntilDestroyed(),
      )
      .subscribe((page) => {
        if (!page) return;
        this.metrics.set(page.metrics);
        this.recent.set(page.recent.items);
        this.error.set(null);
      });
  }
}
