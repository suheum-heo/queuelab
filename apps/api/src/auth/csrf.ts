import { CSRF_HEADER_VALUE } from '@queuelab/shared-types';

export interface CsrfRequest {
  method: string;
  hasSessionCookie: boolean;
  csrfHeader: unknown;
  origin: unknown;
  referer: unknown;
  webOrigin: string;
}

/**
 * A cookie is sent by the browser without the caller's intent. Mutations that
 * rely on it must also carry a header a foreign form cannot set, and an Origin
 * that matches the configured web app. Bearer-only calls are not cookie CSRF.
 */
export function cookieMutationAllowed(input: CsrfRequest): boolean {
  if (!isUnsafe(input.method) || !input.hasSessionCookie) return true;
  if (headerValue(input.csrfHeader) !== CSRF_HEADER_VALUE) return false;
  const origin = headerValue(input.origin);
  if (origin) return origin === input.webOrigin;
  const referer = headerValue(input.referer);
  if (!referer) return false;
  try {
    return new URL(referer).origin === input.webOrigin;
  } catch {
    return false;
  }
}

function isUnsafe(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function headerValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
