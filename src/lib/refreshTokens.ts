import crypto from 'node:crypto';
import { database } from './database';
import { createOpaqueToken, hashOpaqueToken } from './securityTokens';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

export interface IssuedRefreshToken {
  token: string;
  expiresAt: string;
}

function tokenId(): string {
  return `refresh_${crypto.randomBytes(18).toString('base64url')}`;
}

export async function issueRefreshToken(email: string): Promise<IssuedRefreshToken> {
  const generated = createOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  await database.run(
    `INSERT INTO auth_refresh_tokens (id, email, family_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [tokenId(), email, crypto.randomUUID(), generated.hash, expiresAt]
  );
  return { token: generated.token, expiresAt };
}

export async function rotateRefreshToken(token: string): Promise<
  | { status: 'rotated'; email: string; tokenVersion: number; refresh: IssuedRefreshToken }
  | { status: 'invalid' | 'reuse' }
> {
  const tokenHash = hashOpaqueToken(token);
  return database.transaction(async (transaction) => {
    const current = await transaction.get<{
      id: string; email: string; family_id: string; expires_at: string;
      consumed_at: string | null; revoked_at: string | null;
    }>('SELECT id, email, family_id, expires_at, consumed_at, revoked_at FROM auth_refresh_tokens WHERE token_hash = ?', [tokenHash]);
    if (!current || current.revoked_at || new Date(current.expires_at).getTime() <= Date.now()) return { status: 'invalid' };
    if (current.consumed_at) {
      await transaction.run('UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE family_id = ? AND revoked_at IS NULL', [current.family_id]);
      await transaction.run('UPDATE users SET token_version = token_version + 1 WHERE email = ?', [current.email]);
      return { status: 'reuse' };
    }

    const generated = createOpaqueToken();
    const replacementId = tokenId();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
    const consumed = await transaction.run(
      `UPDATE auth_refresh_tokens SET consumed_at = CURRENT_TIMESTAMP, replaced_by = ?
       WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
      [replacementId, current.id]
    );
    if (!consumed.changes) {
      await transaction.run('UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE family_id = ? AND revoked_at IS NULL', [current.family_id]);
      await transaction.run('UPDATE users SET token_version = token_version + 1 WHERE email = ?', [current.email]);
      return { status: 'reuse' };
    }
    await transaction.run(
      `INSERT INTO auth_refresh_tokens (id, email, family_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [replacementId, current.email, current.family_id, generated.hash, expiresAt]
    );
    const user = await transaction.get<{ token_version: number }>('SELECT token_version FROM users WHERE email = ?', [current.email]);
    if (!user) return { status: 'invalid' };
    return { status: 'rotated', email: current.email, tokenVersion: Number(user.token_version), refresh: { token: generated.token, expiresAt } };
  });
}

export async function revokeRefreshTokensForUser(email: string): Promise<void> {
  await database.run(
    'UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE email = ? AND revoked_at IS NULL',
    [email]
  );
}
