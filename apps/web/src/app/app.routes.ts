import { Routes } from '@angular/router';

export const routes: Routes = [
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
  { path: '**', redirectTo: 'dashboard' },
];
