export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  dev: boolean;
  webOrigin: string;
}

/**
 * An empty OIDC_ISSUER keeps the local sign-in page. A public deployment sets a
 * real issuer. Production refuses to boot without one, so the local page cannot
 * mint a token for any email on the internet.
 */
export function oidcSettings(): OidcSettings {
  const port = process.env.PORT ?? '3000';
  const configured = process.env.OIDC_ISSUER?.trim() ?? '';
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('OIDC_ISSUER is required when NODE_ENV is production');
  }

  const clientId = process.env.OIDC_CLIENT_ID?.trim() || 'queuelab';
  const webOrigin = (process.env.WEB_ORIGIN ?? 'http://localhost:4200').replace(/\/$/, '');
  return {
    issuer: (configured || `http://127.0.0.1:${port}/api/v1/oidc`).replace(/\/$/, ''),
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET?.trim() ?? '',
    redirectUri:
      process.env.OIDC_REDIRECT_URI?.trim() || `${webOrigin}/api/v1/auth/callback`,
    dev: configured.length === 0,
    webOrigin,
  };
}
