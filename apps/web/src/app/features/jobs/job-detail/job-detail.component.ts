import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { isActiveStatus, type AnalysisReport, type JobEventView, type JobResultView, type JobView } from '@queuelab/shared-types';
import { EMPTY, forkJoin, of, timer } from 'rxjs';
import { catchError, filter, map, switchMap, takeWhile, tap } from 'rxjs/operators';
import { httpErrorMessage } from '../../../core/api/http-error';
import { JobApiService } from '../../../core/api/job-api.service';
import { ProgressBarComponent } from '../../../shared/components/progress-bar.component';
import { StatusBadgeComponent } from '../../../shared/components/status-badge.component';

@Component({
  selector: 'app-job-detail',
  imports: [RouterLink, DatePipe, DecimalPipe, StatusBadgeComponent, ProgressBarComponent],
  templateUrl: './job-detail.component.html',
})
export class JobDetailComponent {
  private readonly api = inject(JobApiService);
  private readonly route = inject(ActivatedRoute);

  readonly job = signal<JobView | null>(null);
  readonly events = signal<JobEventView[]>([]);
  readonly result = signal<JobResultView | null>(null);
  readonly error = signal<string | null>(null);
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

  private watch(id: string) {
    this.job.set(null);
    this.events.set([]);
    this.result.set(null);
    this.error.set(null);

    return timer(0, 1000).pipe(
      switchMap(() => this.load(id)),
      takeWhile(() => {
        const status = this.job()?.status;
        return !status || isActiveStatus(status);
      }, true),
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
