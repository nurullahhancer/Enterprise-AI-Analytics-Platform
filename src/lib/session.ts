import { Request, Response } from 'express';

const COOKIE_NAME = 'reai_session';
const EIGHT_HOURS_SECONDS = 8 * 60 * 60;

function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function serializeCookie(value: string, maxAge: number): string {
  const secure = cookieSecure() ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function setSessionCookie(res: Response, token: string): void {
  res.setHeader('Set-Cookie', serializeCookie(token, EIGHT_HOURS_SECONDS));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', serializeCookie('', 0));
}

export function sessionTokenFromRequest(req: Request): string | null {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7);

  const rawCookie = req.headers.cookie;
  if (!rawCookie) return null;
  for (const entry of rawCookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function shouldReturnBearerToken(req: Request): boolean {
  const clientType = String(req.headers['x-client-type'] || '').toLowerCase();
  return clientType === 'mobile' || clientType === 'api' || process.env.NODE_ENV === 'test';
}

