import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth';

/** Typed request carrying authenticated user */
export interface AuthenticatedRequest extends Request {
  user?: { email: string };
}

/** JWT auth middleware — rejects with 401 if token is missing or invalid */
export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const decoded = verifyToken(header.substring(7));
    if (decoded) { req.user = decoded; return next(); }
  }
  return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması başarısız. Lütfen giriş yapın.' } });
}
