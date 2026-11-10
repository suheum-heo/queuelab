import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (tracked.includes('.env')) {
  console.error('.env is tracked. Keep secrets out of git.');
  process.exit(1);
}

const patterns = [
  { name: 'private key', pattern: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/ },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

let failed = false;
for (const file of tracked) {
  if (file === 'scripts/check-secrets.mjs') continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const check of patterns) {
    if (check.pattern.test(text)) {
      console.error(`${file} looks like it contains a ${check.name}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`Checked ${tracked.length} tracked files for secrets.`);
