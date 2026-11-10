export interface AuthorizeFields {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  scope: string;
}

export function signInPage(fields: AuthorizeFields, error?: string): string {
  const message = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : '<p>Enter the email for this ledger. The API keeps a local user row and checks the token on every request.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sign in · QueueLab</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #12140f; color: #f4efe4; font: 18px/1.5 Outfit, "Avenir Next", sans-serif; }
    form { width: min(420px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 14px; padding: 28px; border: 1px solid rgba(244,239,228,.12); border-radius: 16px; background: #1b1e16; }
    h1 { margin: 0; font: 560 40px/1 Fraunces, Georgia, serif; letter-spacing: -0.03em; }
    p { margin: 0; color: #b7b09f; }
    .error { color: #ef7b68; }
    input, button { font: inherit; }
    input { padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(244,239,228,.12); background: #12140f; color: inherit; }
    button { padding: 10px 14px; border: 0; border-radius: 999px; background: #e38b45; color: #24150c; font-weight: 650; cursor: pointer; }
  </style>
</head>
<body>
  <form method="post" action="/api/v1/oidc/authorize">
    <h1>Sign in</h1>
    ${message}
    ${hidden('client_id', fields.clientId)}
    ${hidden('redirect_uri', fields.redirectUri)}
    ${hidden('state', fields.state)}
    ${hidden('nonce', fields.nonce)}
    ${hidden('code_challenge', fields.challenge)}
    ${hidden('code_challenge_method', 'S256')}
    ${hidden('scope', fields.scope)}
    ${hidden('response_type', 'code')}
    <label>Email <input name="email" type="email" autocomplete="username" required maxlength="200"></label>
    <button type="submit">Continue</button>
  </form>
</body>
</html>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
