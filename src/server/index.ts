import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth';
import { DbUser, findUserByEmail, getActiveMembership, OrganizationMembership } from '../lib/db';
import { sessionTokenFromRequest } from '../lib/session';

/** Typed request carrying authenticated user */
export interface AuthenticatedRequest extends Request {
  user?: Pick<DbUser, 'email' | 'name' | 'role' | 'token_version'>;
  organization?: Pick<OrganizationMembership, 'organization_id' | 'organization_name' | 'organization_slug' | 'plan_key'>;
}

/** JWT auth middleware — rejects with 401 if token is missing or invalid */
export async function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = sessionTokenFromRequest(req);
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      try {
        const user = await findUserByEmail(decoded.email);
        if (user && user.token_version === decoded.tokenVersion) {
          if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && !user.email_verified_at) {
            return res.status(403).json({ error: { code: 'EMAIL_NOT_VERIFIED', message: 'Devam etmek için e-posta adresinizi doğrulayın.' } });
          }
          const requestedOrganizationId = String(req.headers['x-organization-id'] || '').trim();
          if (requestedOrganizationId && !/^[A-Za-z0-9_-]{8,80}$/.test(requestedOrganizationId)) {
            return res.status(400).json({ error: { code: 'INVALID_ORGANIZATION', message: 'Organizasyon kimliği geçersiz.' } });
          }
          const membership = await getActiveMembership(user.email, requestedOrganizationId || undefined);
          if (!membership) {
            return res.status(403).json({ error: { code: 'ORGANIZATION_ACCESS_DENIED', message: 'Bu organizasyona erişiminiz yok.' } });
          }
          req.user = {
            email: user.email,
            name: user.name,
            role: membership.role,
            token_version: user.token_version
          };
          req.organization = {
            organization_id: membership.organization_id,
            organization_name: membership.organization_name,
            organization_slug: membership.organization_slug,
            plan_key: membership.plan_key
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
