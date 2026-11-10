import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { signInPage, type AuthorizeFields } from './dev-oidc.page';
import { oidcSettings } from './oidc-settings';

const CODE_TTL_MS = 2 * 60_000;
const TOKEN_TTL = '1h';

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  email: string;
  nonce: string;
  state: string;
  expiresAt: number;
}

export interface IssuedTokens {
  access_token: string;
  id_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/**
 * Authorization-code + PKCE issuer used when OIDC_ISSUER is unset.
 * One process holds the signing key and the codes. A second API process
 * would not accept those codes.
 */
@Injectable()
export class DevOidcService implements OnModuleInit {
  private readonly logger = new Logger(DevOidcService.name);
  private settings = oidcSettings();
  private privateKey?: KeyLike;
  private publicKey?: KeyLike;
  private publicJwk?: JWK;
  private readonly codes = new Map<string, PendingCode>();

  async onModuleInit(): Promise<void> {
    this.settings = oidcSettings();
    if (!this.settings.dev) return;
    const pair = await generateKeyPair('RS256');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = 'queuelab-dev';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    this.publicJwk = jwk;
    this.logger.warn('Local OpenID provider is on. Set OIDC_ISSUER before exposing this API.');
  }

  enabled(): boolean {
    return this.settings.dev;
  }

  signingKey(): KeyLike | undefined {
    return this.publicKey;
  }

  discovery(): Record<string, unknown> {
    const issuer = this.settings.issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'email'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  }

  jwks(): { keys: JWK[] } {
    return { keys: this.publicJwk ? [this.publicJwk] : [] };
  }

  form(query: Record<string, unknown>, error?: string): string | null {
    const fields = this.fields(query);
    if (!fields) return null;
    return signInPage(fields, error);
  }

  submit(body: Record<string, unknown>): { kind: 'redirect'; location: string } | { kind: 'form'; html: string } {
    const fields = this.fields(body);
    if (!fields) return { kind: 'form', html: '<p>Sign-in request was rejected.</p>' };
    const email = normalizeEmail(body.email);
    if (!email) return { kind: 'form', html: signInPage(fields, 'Enter a valid email address.') };
    this.sweep();
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId: fields.clientId,
      redirectUri: fields.redirectUri,
      challenge: fields.challenge,
      email,
      nonce: fields.nonce,
      state: fields.state,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const location = new URL(fields.redirectUri);
    location.searchParams.set('code', code);
    location.searchParams.set('state', fields.state);
    return { kind: 'redirect', location: location.toString() };
  }

  async exchange(body: Record<string, unknown>): Promise<IssuedTokens> {
    const code = text(body.code);
    const pending = code ? this.codes.get(code) : undefined;
    if (code) this.codes.delete(code);
    if (!pending || pending.expiresAt <= Date.now()) throw new Error('invalid_grant');
    if (text(body.grant_type) !== 'authorization_code') throw new Error('invalid_grant');
    if (text(body.client_id) !== pending.clientId) throw new Error('invalid_grant');
    if (text(body.redirect_uri) !== pending.redirectUri) throw new Error('invalid_grant');
    const verifier = text(body.code_verifier);
    if (!verifier || !pkceMatches(verifier, pending.challenge)) throw new Error('invalid_grant');
    if (!this.privateKey) throw new Error('invalid_grant');

    const subject = `local|${pending.email}`;
    const shared = {
      email: pending.email,
      email_verified: true,
    };
    const accessToken = await new SignJWT(shared)
      .setProtectedHeader({ alg: 'RS256', kid: 'queuelab-dev' })
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.clientId)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(this.privateKey);
    const idToken = await new SignJWT({ ...shared, nonce: pending.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'queuelab-dev' })
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.clientId)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(this.privateKey);

    return {
      access_token: accessToken,
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 3600,
    };
  }

  private fields(source: Record<string, unknown>): AuthorizeFields | null {
    const clientId = text(source.client_id);
    const redirectUri = text(source.redirect_uri);
    const state = text(source.state);
    const nonce = text(source.nonce);
    const challenge = text(source.code_challenge);
    const method = text(source.code_challenge_method);
    const scope = text(source.scope);
    const responseType = text(source.response_type);
    if (clientId !== this.settings.clientId) return null;
    if (redirectUri !== this.settings.redirectUri) return null;
    if (!state || state.length > 400) return null;
    if (!nonce || nonce.length > 400) return null;
    if (!challenge || challenge.length > 200) return null;
    if (method !== 'S256') return null;
    if (responseType !== 'code') return null;
    if (!scope?.split(' ').includes('openid')) return null;
    return { clientId, redirectUri, state, nonce, challenge, scope };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, pending] of this.codes) {
      if (pending.expiresAt <= now) this.codes.delete(code);
    }
  }
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const actual = createHash('sha256').update(verifier).digest('base64url');
  const left = Buffer.from(actual);
  const right = Buffer.from(challenge);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
