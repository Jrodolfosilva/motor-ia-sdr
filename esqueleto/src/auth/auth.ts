// Login do painel: e-mail + código do autenticador → cookie de sessão (HttpOnly) guardado no Redis.
import { createHash, randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { redis } from '../db/connection';
import { UserModel } from '../db/models/User';
import { allowHit } from '../adapters/rateLimit';
import { verifyTotp } from './totp';

const COOKIE = 'hub_sid';
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
const sessKey = (token: string) => `auth:sess:${createHash('sha256').update(token).digest('hex')}`;

export interface AuthUser { id: string; name: string; email: string; role: 'admin' }

function readCookie(req: Request, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(req: Request, res: Response, value: string, maxAgeSec: number) {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/** Usuário logado (ou null). Guarda em req para não consultar duas vezes. */
export async function currentUser(req: Request): Promise<AuthUser | null> {
  const cached = (req as any)._authUser as AuthUser | null | undefined;
  if (cached !== undefined) return cached;
  let user: AuthUser | null = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    const id = await redis.get(sessKey(token));
    if (id) {
      const u = await UserModel.findById(id).lean();
      if (u?.active) user = { id: String(u._id), name: u.name, email: u.email, role: u.role };
    }
  }
  (req as any)._authUser = user;
  return user;
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    if (await currentUser(req)) return next();
    res.status(401).json({ error: 'Faça login para continuar.' });
  } catch (e) {
    next(e);
  }
}

const GENERIC_FAIL = 'E-mail ou código inválido.';

export const authRouter = express.Router();

authRouter.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const code = String(req.body?.code ?? '').replace(/\s+/g, '');
  if (!email || !code) return res.status(400).json({ error: 'Informe e-mail e código.' });

  // 6 dígitos = 1 milhão de combinações: limite por IP e por e-mail (Redis)
  const ipOk = await allowHit(`login:ip:${req.ip}`, 20, 15 * 60);
  const emailOk = await allowHit(`login:email:${email}`, 5, 15 * 60);
  if (!ipOk || !emailOk) return res.status(429).json({ error: 'Muitas tentativas. Espere 15 minutos.' });

  const user = await UserModel.findOne({ email, active: true }).select('+totpSecret +totpLastStep');
  const step = user ? verifyTotp(user.totpSecret, code) : null;
  if (!user || step === null || step <= user.totpLastStep) return res.status(401).json({ error: GENERIC_FAIL });

  // grava o passo só se ninguém usou esse código no meio tempo (corrida)
  const upd = await UserModel.updateOne({ _id: user._id, totpLastStep: { $lt: step } }, { $set: { totpLastStep: step, lastLoginAt: new Date() } });
  if (!upd.modifiedCount) return res.status(401).json({ error: GENERIC_FAIL });

  const token = randomBytes(32).toString('base64url');
  await redis.set(sessKey(token), String(user._id), 'EX', SESSION_TTL_SEC);
  setCookie(req, res, token, SESSION_TTL_SEC);
  res.json({ user: { id: String(user._id), name: user.name, email: user.email, role: user.role } });
});

authRouter.post('/logout', async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await redis.del(sessKey(token));
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

authRouter.get('/me', async (req, res) => {
  const user = await currentUser(req);
  user ? res.json({ user }) : res.status(401).json({ error: 'Não logado.' });
});
