import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth';
import { DbUser, findUserByEmail } from '../lib/db';

/** Typed request carrying authenticated user */
export interface AuthenticatedRequest extends Request {
  user?: Pick<DbUser, 'email' | 'name' | 'role' | 'token_version'>;
}

/** JWT auth middleware — rejects with 401 if token is missing or invalid */
export async function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const decoded = verifyToken(header.substring(7));
    if (decoded) {
      try {
        const user = await findUserByEmail(decoded.email);
        if (user && user.token_version === decoded.tokenVersion) {
          req.user = {
            email: user.email,
            name: user.name,
            role: user.role,
            token_version: user.token_version
          };
          return next();
        }
      } catch (error) {
        return next(error);
      }
    }
  }
  return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması başarısız. Lütfen giriş yapın.' } });
}

export function requireRoles(...roles: DbUser['role'][]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması gerekli.' } });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Bu işlem için yetkiniz yok.' } });
    }
    next();
  };
}
