import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  cookieSecret,
  readTransaction,
  signTransaction,
  type OidcTransaction,
} from './cookies';
import { DevOidcService } from './dev-oidc.service';
import { oidcSettings, type OidcSettings } from './oidc-settings';
import { TokenService } from './token.service';

export class SignInError extends Error {}

export interface CompletedSignIn {
  token: string;
  maxAgeMs: number;
  redirectTo: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly secret = cookieSecret();

  constructor(
    private readonly tokens: TokenService,
    private readonly dev: DevOidcService,
  ) {}

  begin(returnTo: unknown): { url: string; cookie: string } {
    const settings = oidcSettings();
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const transaction: OidcTransaction = {
      state,
      nonce,
      verifier,
      returnTo: safeReturnPath(returnTo),
      exp: Date.now() + 10 * 60_000,
    };
    const url = new URL(`${settings.issuer}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.clientId);
    url.searchParams.set('redirect_uri', settings.redirectUri);
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), cookie: signTransaction(this.secret, transaction) };
  }

  async complete(input: {
    code?: string;
    state?: string;
    error?: string;
    cookie?: string;
  }): Promise<CompletedSignIn> {
    if (input.error) throw new SignInError('Sign-in was cancelled.');
    const saved = readTransaction(this.secret, input.cookie);
    if (
      !saved ||
      !input.code ||
      !input.state ||
      !same(saved.state, input.state) ||
      saved.exp < Date.now()
    ) {
      throw new SignInError('Sign-in could not be verified. Try again.');
    }

    const settings = oidcSettings();
    const tokens = settings.dev
      ? await this.dev.exchange({
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: settings.redirectUri,
          client_id: settings.clientId,
          code_verifier: saved.verifier,
        })
      : await this.exchangeRemote(input.code, saved.verifier, settings);
    const identity = await this.tokens.identityFromCallback(tokens.id_token, saved.nonce);
    const linked = await this.tokens.link(identity.sub, identity.email);
    if (linked === 'conflict') {
      throw new SignInError('That email is already linked to a different sign-in.');
    }
    return {
      token: tokens.id_token,
      maxAgeMs: Math.max(identity.maxAgeMs, 1_000),
      redirectTo: `${settings.webOrigin}${saved.returnTo}`,
    };
  }

  private async exchangeRemote(
    code: string,
    verifier: string,
    settings: OidcSettings,
  ): Promise<{ id_token: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: settings.redirectUri,
      client_id: settings.clientId,
      code_verifier: verifier,
    });
    if (settings.clientSecret) body.set('client_secret', settings.clientSecret);
    const response = await fetch(await this.tokens.tokenEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      this.logger.warn(`OpenID token endpoint rejected the sign-in (${response.status})`);
      throw new SignInError('Sign-in could not be verified. Try again.');
    }
    const parsed = (await response.json()) as { id_token?: unknown };
    if (typeof parsed.id_token !== 'string' || !parsed.id_token) {
      throw new SignInError('Sign-in could not be verified. Try again.');
    }
    return { id_token: parsed.id_token };
  }
}

export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string') return '/dashboard';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/dashboard';
  if (value.startsWith('/sign-in') || value.includes('://') || value.includes('\\')) return '/dashboard';
  return value;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
