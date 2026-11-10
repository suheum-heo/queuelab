export interface ProductionEnv {
  NODE_ENV?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_REDIRECT_URI?: string;
  WEB_ORIGIN?: string;
  AUTH_COOKIE_SECRET?: string;
  COOKIE_SECURE?: string;
}

/**
 * Production must use a real HTTPS issuer. The local email form is refused here,
 * and again if a non-production process is reached from anything other than localhost.
 */
export function assertProductionConfig(env: ProductionEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  const issuer = env.OIDC_ISSUER?.trim() ?? '';
  if (!issuer.startsWith('https://') || isLocalIssuer(issuer)) {
    problems.push('OIDC_ISSUER must be an https issuer that is not a local address');
  }
  if (!env.OIDC_CLIENT_ID?.trim()) problems.push('OIDC_CLIENT_ID is required');
  if (!env.OIDC_REDIRECT_URI?.trim().startsWith('https://')) {
    problems.push('OIDC_REDIRECT_URI must be an https URL');
  }
  if (!env.WEB_ORIGIN?.trim().startsWith('https://')) problems.push('WEB_ORIGIN must be an https origin');
  if ((env.AUTH_COOKIE_SECRET?.trim().length ?? 0) < 16) {
    problems.push('AUTH_COOKIE_SECRET must be at least 16 characters');
  }
  if (env.COOKIE_SECURE === 'false') problems.push('COOKIE_SECURE cannot be false');
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n${problems.join('\n')}`);
  }
}

/** The email form is only served when the browser is talking to loopback. */
export function isIsolatedDevHost(hostHeader: string | undefined): boolean {
  const host = (hostHeader ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  const withoutPort = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.replace(/:\d+$/, '');
  return withoutPort === 'localhost' || withoutPort === '127.0.0.1' || withoutPort === '::1';
}

function isLocalIssuer(issuer: string): boolean {
  try {
    const host = new URL(issuer).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return true;
  }
}
