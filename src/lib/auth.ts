import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const JWT_ISSUER = process.env.JWT_ISSUER || 'reai-platform';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'reai-web';
const TEST_JWT_SECRET = 'test-only-jwt-secret-not-valid-for-production-2026';

export class AuthConfigurationError extends Error {
  constructor() {
    super('Kimlik doğrulama servisi henüz yapılandırılmadı.');
    this.name = 'AuthConfigurationError';
  }
}

function getJwtSecret(): string | null {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'test') return TEST_JWT_SECRET;
  return null;
}

export function isAuthConfigured(): boolean {
  return getJwtSecret() !== null;
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  length: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, length, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function derivePbkdf2(password: string, salt: string, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 1000, length, 'sha512', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const cost = 32_768;
  const blockSize = 8;
  const parallelization = 1;
  const hash = await deriveScrypt(password, salt, 64, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    if (storedHash.startsWith('scrypt$')) {
      const [, costText, blockSizeText, parallelizationText, saltText, hashText] = storedHash.split('$');
      const expected = Buffer.from(hashText, 'base64');
      const actual = await deriveScrypt(password, Buffer.from(saltText, 'base64'), expected.length, {
        N: Number(costText),
        r: Number(blockSizeText),
        p: Number(parallelizationText),
        maxmem: 64 * 1024 * 1024
      });
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }

    // Legacy PBKDF2 hashes are accepted once so an existing user can log in and
    // be transparently upgraded to scrypt by the login handler.
    const [salt, hashText] = storedHash.split(':');
    if (!salt || !hashText || !/^[a-f0-9]+$/i.test(hashText)) return false;
    const expected = Buffer.from(hashText, 'hex');
    const actual = await derivePbkdf2(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function passwordHashNeedsUpgrade(storedHash: string): boolean {
  return !storedHash.startsWith('scrypt$');
}

export function generateToken(email: string, tokenVersion: number): string {
  const secret = getJwtSecret();
  if (!secret) throw new AuthConfigurationError();
  return jwt.sign(
    { email, tokenVersion },
    secret,
    {
      algorithm: 'HS256',
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
      subject: email,
      jwtid: crypto.randomUUID(),
      expiresIn: '8h'
    }
  );
}

export function verifyToken(token: string): { email: string; tokenVersion: number } | null {
  const secret = getJwtSecret();
  if (!secret) return null;
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER
    }) as jwt.JwtPayload;
    if (typeof decoded.email !== 'string' || !Number.isInteger(decoded.tokenVersion)) return null;
    return { email: decoded.email, tokenVersion: decoded.tokenVersion as number };
  } catch {
    return null;
  }
}
