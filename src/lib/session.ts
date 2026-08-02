import { Request, Response } from 'express';

const COOKIE_NAME = 'reai_session';
const REFRESH_COOKIE_NAME = 'reai_refresh';
const ACCESS_TOKEN_SECONDS = 30 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function serializeCookie(name: string, value: string, maxAge: number, path = '/'): string {
  const secure = cookieSecure() ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function appendCookie(res: Response, cookie: string): void {
  const current = res.getHeader('Set-Cookie');
  const values = Array.isArray(current) ? current.map(String) : current ? [String(current)] : [];
  res.setHeader('Set-Cookie', [...values, cookie]);
}

export function setSessionCookie(res: Response, token: string): void {
  appendCookie(res, serializeCookie(COOKIE_NAME, token, ACCESS_TOKEN_SECONDS));
}

export function setRefreshCookie(res: Response, token: string): void {
  appendCookie(res, serializeCookie(REFRESH_COOKIE_NAME, token, REFRESH_TOKEN_SECONDS, '/api/refresh'));
}

export function clearSessionCookie(res: Response): void {
  appendCookie(res, serializeCookie(COOKIE_NAME, '', 0));
  appendCookie(res, serializeCookie(REFRESH_COOKIE_NAME, '', 0, '/api/refresh'));
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

export function refreshTokenFromRequest(req: Request): string | null {
  if (typeof req.body?.refreshToken === 'string') return req.body.refreshToken;
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return null;
  for (const entry of rawCookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) continue;
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
