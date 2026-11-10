import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { catchError, map, of, tap } from 'rxjs';
import { AuthService, safeReturnPath } from './auth.service';

/** Keeps an anonymous visitor on the sign-in page. The API still checks every request. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.me().pipe(
    tap((user) => auth.user.set(user)),
    map(() => true),
    catchError(() => {
      auth.user.set(null);
      return of(
        router.createUrlTree(['/sign-in'], {
          queryParams: { return: safeReturnPath(state.url) },
        }),
      );
    }),
  );
};
