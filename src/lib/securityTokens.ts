import crypto from 'node:crypto';

export function createOpaqueToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function safeTokenHashMatch(presentedToken: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashOpaqueToken(presentedToken), 'hex');
  const expectedHash = Buffer.from(storedHash, 'hex');
  return presentedHash.length === expectedHash.length && crypto.timingSafeEqual(presentedHash, expectedHash);
}

