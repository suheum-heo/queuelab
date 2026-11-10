import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@queuelab/shared-types';
import { catchError, throwError } from 'rxjs';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const router = inject(Router);
  const authed = request.url.startsWith('/api/')
    ? request.clone({ withCredentials: true, setHeaders: { [CSRF_HEADER]: CSRF_HEADER_VALUE } })
    : request;
  return next(authed).pipe(
    catchError((error: unknown) => {
      const onSignIn = router.url.startsWith('/sign-in');
      const identityCheck = request.url.includes('/auth/me');
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        !identityCheck &&
        !onSignIn
      ) {
        void router.navigate(['/sign-in'], { queryParams: { return: router.url } });
      }
      return throwError(() => error);
    }),
  );
};
