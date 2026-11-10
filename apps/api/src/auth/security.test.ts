import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { describe, it } from 'node:test';
import { cookieMutationAllowed } from './csrf';
import { assertProductionConfig, isIsolatedDevHost } from './production-config';
import { verifyOidcToken } from './verify-claims';

const ISSUER = 'https://id.example.test';
const CLIENT = 'queuelab';
const WEB = 'https://app.example.test';

describe('production configuration', () => {
  it('accepts a complete https configuration', () => {
    assert.doesNotThrow(() =>
      assertProductionConfig({
        NODE_ENV: 'production',
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: CLIENT,
        OIDC_REDIRECT_URI: `${WEB}/api/v1/auth/callback`,
        WEB_ORIGIN: WEB,
        AUTH_COOKIE_SECRET: 'a-real-cookie-secret',
      }),
    );
  });

  it('rejects the local email issuer and an insecure origin', () => {
    assert.throws(() =>
      assertProductionConfig({
        NODE_ENV: 'production',
        OIDC_ISSUER: 'http://127.0.0.1:3000/api/v1/oidc',
        OIDC_CLIENT_ID: '',
        OIDC_REDIRECT_URI: 'http://localhost:4200/api/v1/auth/callback',
        WEB_ORIGIN: 'http://localhost:4200',
        AUTH_COOKIE_SECRET: 'short',
        COOKIE_SECURE: 'false',
      }),
    );
  });

  it('leaves development settings alone', () => {
    assert.doesNotThrow(() => assertProductionConfig({ NODE_ENV: 'development' }));
  });

  it('treats only loopback as an isolated sign-in host', () => {
    assert.equal(isIsolatedDevHost('localhost:4200'), true);
    assert.equal(isIsolatedDevHost('127.0.0.1:3000'), true);
    assert.equal(isIsolatedDevHost('[::1]:3000'), true);
    assert.equal(isIsolatedDevHost('queuelab.example.test'), false);
    assert.equal(isIsolatedDevHost(undefined), false);
  });
});

describe('cookie CSRF', () => {
  const base = { method: 'POST', hasSessionCookie: true, webOrigin: WEB };

  it('allows a read and a bearer-only mutation', () => {
    assert.equal(cookieMutationAllowed({ ...base, method: 'GET', csrfHeader: undefined, origin: undefined, referer: undefined }), true);
    assert.equal(
      cookieMutationAllowed({ ...base, hasSessionCookie: false, csrfHeader: undefined, origin: 'https://evil.test', referer: undefined }),
      true,
    );
  });

  it('requires the header and a matching origin when the session cookie is sent', () => {
    assert.equal(cookieMutationAllowed({ ...base, csrfHeader: undefined, origin: WEB, referer: undefined }), false);
    assert.equal(cookieMutationAllowed({ ...base, csrfHeader: '1', origin: 'https://evil.test', referer: undefined }), false);
    assert.equal(cookieMutationAllowed({ ...base, csrfHeader: '1', origin: undefined, referer: undefined }), false);
    assert.equal(cookieMutationAllowed({ ...base, csrfHeader: '1', origin: WEB, referer: undefined }), true);
    assert.equal(
      cookieMutationAllowed({ ...base, csrfHeader: '1', origin: undefined, referer: `${WEB}/jobs` }),
      true,
    );
  });
});

describe('OpenID token checks', () => {
  it('accepts a signed token and rejects a bad audience, issuer, signature, expiry, or nonce', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const token = await sign(privateKey, '1h', 'nonce-1');
    const identity = await verifyOidcToken(token, publicKey, { issuer: ISSUER, clientId: CLIENT }, 'nonce-1');
    assert.equal(identity.email, 'a@example.test');
    assert.equal(identity.sub, 'user-a');

    await assert.rejects(() => verifyOidcToken(token, publicKey, { issuer: ISSUER, clientId: 'other' }));
    await assert.rejects(() => verifyOidcToken(token, publicKey, { issuer: 'https://other.example.test', clientId: CLIENT }));
    await assert.rejects(() => verifyOidcToken(token, other.publicKey, { issuer: ISSUER, clientId: CLIENT }));
    await assert.rejects(() => verifyOidcToken(token, publicKey, { issuer: ISSUER, clientId: CLIENT }, 'other-nonce'));
    const expired = await sign(privateKey, Math.floor(Date.now() / 1000) - 120, 'nonce-1');
    await assert.rejects(() => verifyOidcToken(expired, publicKey, { issuer: ISSUER, clientId: CLIENT }));
  });
});

function sign(key: KeyLike, exp: string | number, nonce: string): Promise<string> {
  return new SignJWT({ email: 'a@example.test', nonce })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(CLIENT)
    .setSubject('user-a')
    .setExpirationTime(exp)
    .sign(key);
}
