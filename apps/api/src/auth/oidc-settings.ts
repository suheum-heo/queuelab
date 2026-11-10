import { assertProductionConfig } from './production-config';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  dev: boolean;
  webOrigin: string;
}

/**
 * An empty OIDC_ISSUER keeps the local sign-in page on localhost only.
 * Production refuses to boot unless the issuer, origin, redirect, and cookie
 * secret are all set for HTTPS.
 */
export function oidcSettings(): OidcSettings {
  assertProductionConfig();
  const port = process.env.PORT ?? '3000';
  const configured = process.env.OIDC_ISSUER?.trim() ?? '';

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
