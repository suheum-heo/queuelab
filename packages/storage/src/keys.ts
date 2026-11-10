/** Rejects a key that could leave the bucket prefix or the local storage root. */
export function safeObjectKey(key: string): string {
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\0')) {
    throw new Error(`Storage key is not allowed: ${key}`);
  }
  const parts = key.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`Storage key is not allowed: ${key}`);
  }
  return key;
}
