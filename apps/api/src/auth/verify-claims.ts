import { jwtVerify, type JWTPayload, type JWTVerifyOptions, type KeyLike } from 'jose';
import { normalizeEmail } from './dev-oidc.service';

export interface VerifiedIdentity {
  sub: string;
  email: string;
  maxAgeMs: number;
}

/** Shared by the API and the security test so issuer, audience, and expiry stay enforced. */
export function oidcVerifyOptions(settings: { issuer: string; clientId: string }): JWTVerifyOptions {
  return {
    issuer: settings.issuer,
    audience: settings.clientId,
    clockTolerance: 5,
  };
}

export function claimsFromPayload(payload: JWTPayload, nonce?: string): VerifiedIdentity {
  const email = normalizeEmail(payload.email);
  if (!payload.sub || !email) throw new Error('Token is missing a subject or email');
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error('Token nonce does not match');
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  return {
    sub: payload.sub,
    email,
    maxAgeMs: Math.max(0, exp * 1000 - Date.now()),
  };
}

export async function verifyOidcToken(
  token: string,
  key: KeyLike,
  settings: { issuer: string; clientId: string },
  nonce?: string,
): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(token, key, oidcVerifyOptions(settings));
  return claimsFromPayload(payload, nonce);
}
