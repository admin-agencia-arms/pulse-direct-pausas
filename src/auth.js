import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sql } from './db.js';

export const COOKIE = 'pd_session';
const SESSION_MS = Number(process.env.SESSION_HOURS || 12) * 3600_000;
const SECURE = process.env.COOKIE_SECURE === 'true';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const normEmail = (e) => String(e || '').trim().toLowerCase();

export async function findUserByEmail(email) {
  const [u] = await sql`SELECT * FROM users WHERE email = ${normEmail(email)}`;
  return u ?? null;
}

export const hashPassword = (p) => bcrypt.hash(p, 10);
export const checkPassword = (p, h) => bcrypt.compare(p, h);

export function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (p.length > 128) return 'Senha muito longa.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Use letras e números na senha.';
  return null;
}

export async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = Date.now();
  await sql`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (${sha(token)}, ${userId}, ${t}, ${t + SESSION_MS})`;
  await sql`UPDATE users SET last_login_at = ${t} WHERE id = ${userId}`;
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: SESSION_MS, path: '/' });
}

export async function destroySession(req, res) {
  const token = readCookie(req);
  if (token) await sql`DELETE FROM sessions WHERE token_hash = ${sha(token)}`;
  res.clearCookie(COOKIE, { path: '/' });
}

export async function destroyUserSessions(userId) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function requireAuth(req, res, next) {
  try {
    const token = readCookie(req);
    if (!token) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    const [user] = await sql`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${sha(token)} AND s.expires_at > ${Date.now()} AND u.active`;
    if (!user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  next();
}

// Limite de tentativas no banco (funciona entre instâncias serverless): 10 / 15 min por IP+e-mail.
const attemptKey = (req) => `${req.ip}|${normEmail(req.body?.email)}`;
export async function rateLimit(req, res, next) {
  try {
    const key = attemptKey(req);
    const t = Date.now();
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM login_attempts WHERE key = ${key} AND at > ${t - 15 * 60_000}`;
    if (n >= 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    await sql`INSERT INTO login_attempts (key, at) VALUES (${key}, ${t})`;
    if (Math.random() < 0.02) await sql`DELETE FROM login_attempts WHERE at < ${t - 86_400_000}`;
    next();
  } catch (e) {
    next(e);
  }
}
export async function clearRateLimit(req) {
  await sql`DELETE FROM login_attempts WHERE key = ${attemptKey(req)}`;
}

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || u.email,
    role: u.role,
    profile: u.profile,
    departments: u.departments || [],
    isAgent: !!u.crm_user_id,
  };
}
