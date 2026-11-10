import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService, safeReturnPath } from '../../core/auth/auth.service';

@Component({
  selector: 'app-sign-in',
  templateUrl: './sign-in.component.html',
})
export class SignInComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly error = signal(this.route.snapshot.queryParamMap.get('error'));
  readonly loginHref = loginHref(this.route.snapshot.queryParamMap.get('return'));

  constructor() {
    this.auth.me().subscribe({
      next: (user) => {
        this.auth.user.set(user);
        void this.router.navigateByUrl(safeReturnPath(this.route.snapshot.queryParamMap.get('return')));
      },
      error: () => undefined,
    });
  }
}

function loginHref(returnTo: string | null): string {
  return `/api/v1/auth/login?return=${encodeURIComponent(safeReturnPath(returnTo))}`;
}
