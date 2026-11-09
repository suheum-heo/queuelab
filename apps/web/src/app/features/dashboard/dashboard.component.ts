import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { JobView, MetricsOverview } from '@queuelab/shared-types';
import { forkJoin, of, timer } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { httpErrorMessage } from '../../core/api/http-error';
import { JobApiService } from '../../core/api/job-api.service';
import { ProgressBarComponent } from '../../shared/components/progress-bar.component';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, DecimalPipe, StatusBadgeComponent, ProgressBarComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  private readonly api = inject(JobApiService);

  readonly metrics = signal<MetricsOverview | null>(null);
  readonly recent = signal<JobView[]>([]);
  readonly error = signal<string | null>(null);
  readonly processing = computed(() => {
    const metrics = this.metrics();
    if (!metrics) return null;
    return metrics.processing + metrics.retrying;
  });

  constructor() {
    timer(0, 2000)
      .pipe(
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
