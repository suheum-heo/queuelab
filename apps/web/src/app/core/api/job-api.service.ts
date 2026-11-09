import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  JobEventPage,
  JobPage,
  JobResultView,
  JobStatus,
  JobView,
  MetricsOverview,
} from '@queuelab/shared-types';

export interface StoredUpload {
  id: string;
  filename: string;
  sizeBytes: number;
  key: string;
}

export interface CreateJobBody {
  type: 'CSV_ANALYSIS';
  fileId: string;
  options: {
    delimiter: string;
    hasHeader: boolean;
  };
}

@Injectable({ providedIn: 'root' })
export class JobApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/v1';

  overview() {
    return this.http.get<MetricsOverview>(`${this.base}/metrics/overview`);
  }

  list(query: { limit?: number; cursor?: string | null; status?: JobStatus; q?: string }) {
    let params = new HttpParams().set('limit', String(query.limit ?? 20));
    if (query.cursor) params = params.set('cursor', query.cursor);
    if (query.status) params = params.set('status', query.status);
    if (query.q) params = params.set('q', query.q);
    return this.http.get<JobPage>(`${this.base}/jobs`, { params });
  }

  get(id: string) {
    return this.http.get<JobView>(`${this.base}/jobs/${id}`);
  }

  events(id: string) {
    return this.http.get<JobEventPage>(`${this.base}/jobs/${id}/events`, {
      params: new HttpParams().set('limit', '100'),
    });
  }

  result(id: string) {
    return this.http.get<JobResultView>(`${this.base}/jobs/${id}/result`);
  }

  upload(file: File) {
    const body = new FormData();
    body.append('file', file, file.name);
    return this.http.post<StoredUpload>(`${this.base}/uploads`, body);
  }

  create(body: CreateJobBody) {
    return this.http.post<JobView>(`${this.base}/jobs`, body);
  }
}
