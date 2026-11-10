import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: 'sign-in',
    title: 'Sign in · QueueLab',
    loadComponent: () => import('./features/auth/sign-in.component').then((m) => m.SignInComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        title: 'Overview · QueueLab',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'jobs/new',
        title: 'New job · QueueLab',
        loadComponent: () =>
          import('./features/jobs/job-submit/job-submit.component').then((m) => m.JobSubmitComponent),
      },
      {
        path: 'jobs/:id',
        title: 'Job · QueueLab',
        loadComponent: () =>
          import('./features/jobs/job-detail/job-detail.component').then((m) => m.JobDetailComponent),
      },
      {
        path: 'jobs',
        title: 'Jobs · QueueLab',
        loadComponent: () =>
          import('./features/jobs/job-list/job-list.component').then((m) => m.JobListComponent),
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
