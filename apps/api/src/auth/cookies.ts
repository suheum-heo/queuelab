import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

const OIDC_COOKIE = 'queuelab_oidc';
const SESSION_COOKIE = 'queuelab_id';

export interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function readBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token || undefined;
}

/** Call once per process. A new value drops in-flight sign-in attempts. */
export function cookieSecret(): string {
  const configured = process.env.AUTH_COOKIE_SECRET?.trim();
  if (configured && configured.length >= 16) return configured;
  return randomBytes(32).toString('base64url');
}

export function signTransaction(secret: string, value: OidcTransaction): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readTransaction(secret: string, token: string | undefined): OidcTransaction | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<OidcTransaction>;
    if (!parsed || typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string') return null;
    if (typeof parsed.nonce !== 'string' || typeof parsed.returnTo !== 'string') return null;
    if (typeof parsed.exp !== 'number') return null;
    return {
      state: parsed.state,
      nonce: parsed.nonce,
      verifier: parsed.verifier,
      returnTo: parsed.returnTo,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export function writeOidcCookie(response: Response, request: Request, value: string): void {
  response.cookie(OIDC_COOKIE, value, cookieOptions(request, 10 * 60_000));
}

export function writeSessionCookie(
  response: Response,
  request: Request,
  token: string,
  maxAgeMs: number,
): void {
  response.cookie(SESSION_COOKIE, token, cookieOptions(request, maxAgeMs));
}

export function clearAuthCookies(response: Response, request: Request): void {
  const options = cookieOptions(request, 0);
  response.clearCookie(OIDC_COOKIE, options);
  response.clearCookie(SESSION_COOKIE, options);
}

function cookieOptions(request: Request, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cookieSecure(request),
    path: '/',
    maxAge: maxAgeMs,
  };
}

function cookieSecure(request: Request): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true;
  const forwarded = request.headers['x-forwarded-proto'];
  return request.secure || forwarded === 'https';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
