import { Router, Response, NextFunction } from 'express';
import { AuthenticatedRequest, authenticateJWT } from '../index';
import { createUser, findUserByEmail, updateUser, deleteUser } from '../../lib/db';
import { hashPassword, verifyPassword, generateToken } from '../../lib/auth';
import logger from '../../lib/logger';

const router = Router();

router.post('/register', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password)
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'İsim, e-posta ve şifre zorunludur.' } });

    if (await findUserByEmail(email.trim()))
      return res.status(400).json({ error: { code: 'USER_EXISTS', message: 'Bu e-posta ile kayıtlı kullanıcı var.' } });

    await createUser(email.trim(), name.trim(), hashPassword(password));
    logger.info(`Kayıt: ${email.trim()}`);
    res.status(201).json({ message: 'Kullanıcı oluşturuldu. Giriş yapabilirsiniz.' });
  } catch (err) { next(err); }
});

router.post('/login', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'E-posta ve şifre zorunludur.' } });

    const user = await findUserByEmail(email.trim());
    if (!user || !verifyPassword(password, user.password_hash))
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'E-posta veya şifre hatalı.' } });

    const token = generateToken(user.email);
    logger.info(`Giriş: ${user.email}`);
    res.json({ token, user: { id: user.email, name: user.name, email: user.email, role: 'admin' } });
  } catch (err) { next(err); }
});

router.put('/user', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması başarısız.' } });

    const { name, password } = req.body;
    if (!name) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'İsim alanı zorunludur.' } });

    let passwordHash: string | undefined;
    if (password && password.trim().length > 0) {
      passwordHash = hashPassword(password);
    }

    await updateUser(email, name.trim(), passwordHash);
    logger.info(`Kullanıcı güncellendi: ${email}`);
    res.json({ message: 'Profil başarıyla güncellendi.', user: { email, name: name.trim(), id: email, role: 'admin' } });
  } catch (err) { next(err); }
});

router.delete('/user', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması başarısız.' } });

    await deleteUser(email);
    logger.info(`Kullanıcı silindi: ${email}`);
    res.json({ message: 'Hesap başarıyla silindi.' });
  } catch (err) { next(err); }
});

export default router;

