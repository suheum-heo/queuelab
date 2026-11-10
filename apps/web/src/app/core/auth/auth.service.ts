import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { JobRealtimeService } from '../realtime/job-realtime.service';

export interface SignedInUser {
  id: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly realtime = inject(JobRealtimeService);

  readonly user = signal<SignedInUser | null>(null);

  me() {
    return this.http.get<SignedInUser>('/api/v1/auth/me');
  }

  logout(): void {
    this.http.post('/api/v1/auth/logout', {}).subscribe({
      next: () => this.finishLogout(),
      error: () => this.finishLogout(),
    });
  }

  private finishLogout(): void {
    this.user.set(null);
    this.realtime.disconnect();
    void this.router.navigate(['/sign-in']);
  }
}

export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/sign-in')) {
    return '/dashboard';
  }
  if (value.includes('://') || value.includes('\\')) return '/dashboard';
  return value;
}
