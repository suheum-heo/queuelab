import { createHash, randomBytes } from 'node:crypto';

export async function accessToken(
  apiOrigin: string,
  options: { email: string; redirectUri: string; clientId?: string },
): Promise<string> {
  const clientId = options.clientId ?? 'queuelab';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const body = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: options.redirectUri,
    scope: 'openid email',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    email: options.email,
  });
  const authorized = await fetch(`${apiOrigin}/api/v1/oidc/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  const location = authorized.headers.get('location');
  if (authorized.status !== 302 || !location) {
    throw new Error(`authorize failed ${authorized.status} ${await authorized.text()}`);
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error(`authorize redirect had no code: ${location}`);

  const token = await fetch(`${apiOrigin}/api/v1/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const text = await token.text();
  if (!token.ok) throw new Error(`token failed ${token.status} ${text}`);
  const parsed = JSON.parse(text) as { id_token?: string };
  if (!parsed.id_token) throw new Error(`token response missing id_token: ${text}`);
  return parsed.id_token;
}
