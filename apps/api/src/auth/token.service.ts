import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type KeyLike } from 'jose';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth-user';
import { DevOidcService } from './dev-oidc.service';
import { oidcSettings, type OidcSettings } from './oidc-settings';
import { claimsFromPayload, oidcVerifyOptions, verifyOidcToken } from './verify-claims';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Identity {
  sub: string;
  email: string;
  maxAgeMs: number;
}

/**
 * Every protected request presents an OpenID ID token. The signature, issuer,
 * audience, and expiry are checked here. The local user row is what jobs point at.
 */
@Injectable()
export class TokenService {
  private remote?: ReturnType<typeof createRemoteJWKSet>;
  private readonly cache = new Map<string, { user: AuthUser; email: string; exp: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dev: DevOidcService,
  ) {}

  async authenticate(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    try {
      const identity = await this.readIdentity(token);
      const linked = await this.link(identity.sub, identity.email);
      return linked === 'conflict' ? null : linked;
    } catch (error) {
      if (isTokenRejection(error)) return null;
      throw error;
    }
  }

  async authorizationEndpoint(): Promise<string> {
    const discovery = await this.discover(oidcSettings());
    return discovery.authorization_endpoint;
  }

  async tokenEndpoint(): Promise<string> {
    const settings = oidcSettings();
    const discovery = await this.discover(settings);
    return discovery.token_endpoint;
  }

  /**
   * Callback path. Also checks the nonce from the sign-in cookie so a stolen
   * code response cannot be replayed against a different login attempt.
   */
  async identityFromCallback(token: string, nonce: string): Promise<Identity> {
    const identity = await this.readIdentity(token, nonce);
    return identity;
  }

  async link(sub: string, email: string): Promise<AuthUser | 'conflict'> {
    const cached = this.cache.get(sub);
    if (cached && cached.exp > Date.now() && cached.email === email) return cached.user;

    const bySub = await this.prisma.user.findUnique({ where: { oidcSub: sub } });
    if (bySub) {
      const user = { id: bySub.id, email: bySub.email };
      this.remember(sub, email, user);
      return user;
    }

    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      if (byEmail.oidcSub && byEmail.oidcSub !== sub) return 'conflict';
      const updated = await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { oidcSub: sub },
      });
      const user = { id: updated.id, email: updated.email };
      this.remember(sub, email, user);
      return user;
    }

    try {
      const created = await this.prisma.user.create({ data: { email, oidcSub: sub } });
      const user = { id: created.id, email: created.email };
      this.remember(sub, email, user);
      return user;
    } catch (error) {
      if (!isUnique(error)) throw error;
      const again = await this.prisma.user.findUnique({ where: { oidcSub: sub } });
      if (!again || again.email !== email) return 'conflict';
      const user = { id: again.id, email: again.email };
      this.remember(sub, email, user);
      return user;
    }
  }

  private async readIdentity(token: string, nonce?: string): Promise<Identity> {
    const settings = oidcSettings();
    if (settings.dev) return verifyOidcToken(token, this.localKey(), settings, nonce);
    const { payload } = await jwtVerify(token, await this.remoteKey(settings), oidcVerifyOptions(settings));
    return claimsFromPayload(payload, nonce);
  }

  private localKey(): KeyLike {
    const local = this.dev.signingKey();
    if (!local) throw new Error('Local signing key is not ready');
    return local;
  }

  private async remoteKey(settings: OidcSettings): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!this.remote) {
      const discovery = await this.discover(settings);
      this.remote = createRemoteJWKSet(new URL(discovery.jwks_uri));
    }
    return this.remote;
  }

  private async discover(settings: OidcSettings): Promise<Discovery> {
    const response = await fetch(`${settings.issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error(`OpenID discovery failed (${response.status})`);
    const document = (await response.json()) as Partial<Discovery>;
    const issuer = document.issuer?.replace(/\/$/, '');
    if (issuer !== settings.issuer) throw new Error('OpenID issuer mismatch');
    if (!document.authorization_endpoint || !document.token_endpoint || !document.jwks_uri) {
      throw new Error('OpenID discovery is incomplete');
    }
    return {
      issuer: settings.issuer,
      authorization_endpoint: document.authorization_endpoint,
      token_endpoint: document.token_endpoint,
      jwks_uri: document.jwks_uri,
    };
  }

  private remember(sub: string, email: string, user: AuthUser): void {
    this.cache.set(sub, { user, email, exp: Date.now() + 60_000 });
  }
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function isTokenRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return (
    error.name.startsWith('JWT') ||
    error.name.startsWith('JOSE') ||
    error.message.startsWith('Token') ||
    error.message.includes('signing key')
  );
}
