import crypto from 'node:crypto';
import express from 'express';
import { sql, audit, getMeta } from './db.js';
import * as auth from './auth.js';
import * as svc from './service.js';
import { parseRange, loadIntervals, summarize, daysToArray, dayStart, todayKey, DAY } from './stats.js';
import { rotasPublicas as distribuicaoPublica, rotasAdmin as distribuicaoAdmin } from './distribuicao/rotas.js';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Inicialização por instância (cold start)
let ready = null;
const init = () => (ready ??= (async () => {
  await svc.ensureAdmins();
  await sql`DELETE FROM sessions WHERE expires_at < ${Date.now()}`;
})().catch((e) => { ready = null; throw e; }));
app.use('/api', wrap(async (req, res, next) => { await init(); next(); }));

const api = express.Router();

// ---------------- Cron (Vercel) ----------------

api.get('/cron/sync', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const ok = secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return res.status(401).json({ error: 'Não autorizado.' });
  res.json(await svc.syncUsers());
}));

// Distribuição automática: eventos do Pulse Direct e agendador (protegidos por segredo)
api.use('/distribuicao', distribuicaoPublica);

// ---------------- Autenticação ----------------

api.post('/auth/check', auth.rateLimit, wrap(async (req, res) => {
  const email = auth.normEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  let u = await auth.findUserByEmail(email);
  // Atendente recém-criado no Pulse Direct: sincroniza sob demanda (no máx. 1x/min)
  if (!u) {
    const last = Number(await getMeta('last_sync')) || 0;
    if (Date.now() - last > 60_000) {
      await svc.syncUsers().catch(() => {});
      u = await auth.findUserByEmail(email);
    }
  }
  if (!u || !u.active) {
    return res.status(404).json({ error: 'E-mail não encontrado entre os usuários do Pulse Direct.' });
  }
  res.json({ step: u.password_hash ? 'login' : 'first_access', name: u.name?.split(' ')[0] || null });
}));

api.post('/auth/first-access', auth.rateLimit, wrap(async (req, res) => {
  const u = await auth.findUserByEmail(req.body.email);
  if (!u || !u.active) return res.status(404).json({ error: 'E-mail não encontrado.' });
  if (u.password_hash) return res.status(409).json({ error: 'Este usuário já possui senha. Faça login.' });
  const err = auth.validatePassword(req.body.password);
  if (err) return res.status(400).json({ error: err });
  if (req.body.password !== req.body.confirm) return res.status(400).json({ error: 'As senhas não conferem.' });
  const hash = await auth.hashPassword(req.body.password);
  const r = await sql`UPDATE users SET password_hash = ${hash}, updated_at = ${Date.now()} WHERE id = ${u.id} AND password_hash IS NULL RETURNING id`;
  if (!r.length) return res.status(409).json({ error: 'Este usuário já possui senha. Faça login.' });
  await audit(u.id, u.id, 'first_access');
  await auth.clearRateLimit(req);
  await auth.createSession(res, u.id);
  res.json({ ok: true });
}));

api.post('/auth/login', auth.rateLimit, wrap(async (req, res) => {
  const u = await auth.findUserByEmail(req.body.email);
  const ok = u && u.active && u.password_hash && (await auth.checkPassword(String(req.body.password || ''), u.password_hash));
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  await auth.clearRateLimit(req);
  await auth.createSession(res, u.id);
  res.json({ ok: true });
}));

api.post('/auth/logout', wrap(async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ ok: true });
}));

// ---------------- Área do usuário ----------------

api.use(auth.requireAuth);

const reasonsList = () => sql`SELECT * FROM pause_reasons WHERE active ORDER BY sort, name`;

function currentView(c) {
  if (!c) return null;
  return { kind: c.kind, reason: c.reason_name, reasonId: c.reason_id, maxMinutes: c.max_minutes, note: c.note, startedAt: c.started_at };
}

/** início da jornada atual = início do bloco contínuo de períodos encadeados */
function shiftStartFrom(rows, cur) {
  if (!cur) return null;
  let start = cur.started_at;
  for (const r of rows) {
    if (r.started_at >= start) continue;
    if (r.ended_at === start) start = r.started_at;
    else break;
  }
  return start;
}
async function shiftStart(userId, cur) {
  if (!cur) return null;
  const rows = await sql`SELECT started_at, ended_at FROM intervals
    WHERE user_id = ${userId} AND started_at >= ${cur.started_at - 2 * DAY} ORDER BY started_at DESC`;
  return shiftStartFrom(rows, cur);
}

api.get('/me', wrap(async (req, res) => {
  await svc.reconcileUser(req.user);
  const { state, current } = await svc.stateOf(req.user.id);
  const fromTs = dayStart(todayKey());
  const [ivs, reasons, shift] = await Promise.all([
    loadIntervals(fromTs, fromTs + DAY, [req.user.id]),
    reasonsList(),
    shiftStart(req.user.id, current),
  ]);
  const today = summarize(ivs, fromTs, fromTs + DAY).get(req.user.id)?.total;
  res.json({
    serverNow: Date.now(),
    user: auth.publicUser(req.user),
    state,
    current: currentView(current),
    shiftStartedAt: shift,
    reasons,
    today: today || null,
    timeline: ivs.map((i) => ({ kind: i.kind, reason: i.reason_name, reasonId: i.reason_id, note: i.note, start: i.started_at, end: i.ended_at, maxMinutes: i.max_minutes })),
  });
}));

const action = (fn) => wrap(async (req, res) => {
  await fn(req);
  res.json({ ok: true });
});
api.post('/me/start', action((req) => svc.startShift(req.user, req.user.id)));
api.post('/me/pause', action((req) => svc.startPause(req.user, req.body.reasonId, req.body.note, req.user.id)));
api.post('/me/resume', action((req) => svc.endPause(req.user, req.user.id)));
api.post('/me/end', action((req) => svc.endShift(req.user, req.user.id)));

async function userStats(userId, q) {
  const r = parseRange(q, 7);
  const ivs = await loadIntervals(r.fromTs, r.toTs, [userId]);
  const s = summarize(ivs, r.fromTs, r.toTs).get(userId);
  return {
    from: r.from, to: r.to,
    total: s?.total || null,
    days: s ? daysToArray(s.days) : [],
    pauses: ivs.filter((i) => i.kind === 'pause' && i.started_at >= r.fromTs).reverse().map((i) => ({
      reason: i.reason_name, note: i.note, start: i.started_at, end: i.ended_at, maxMinutes: i.max_minutes,
    })),
  };
}

api.get('/me/stats', wrap(async (req, res) => res.json(await userStats(req.user.id, req.query))));

api.put('/me/password', wrap(async (req, res) => {
  const ok = await auth.checkPassword(String(req.body.current || ''), req.user.password_hash || '');
  if (!ok) return res.status(400).json({ error: 'Senha atual incorreta.' });
  const err = auth.validatePassword(req.body.password);
  if (err) return res.status(400).json({ error: err });
  await sql`UPDATE users SET password_hash = ${await auth.hashPassword(req.body.password)}, updated_at = ${Date.now()} WHERE id = ${req.user.id}`;
  await audit(req.user.id, req.user.id, 'change_password');
  res.json({ ok: true });
}));

// ---------------- Administração ----------------

const admin = express.Router();
admin.use(auth.requireAdmin);

const departmentsMap = async () => Object.fromEntries((await sql`SELECT id, name FROM departments`).map((d) => [d.id, d.name]));

admin.get('/departments', wrap(async (req, res) => {
  res.json(await sql`SELECT d.id, d.name FROM departments d
    WHERE EXISTS (SELECT 1 FROM users u WHERE u.active AND d.id = ANY(u.departments)) ORDER BY d.name`);
}));

admin.get('/team', wrap(async (req, res) => {
  // visão em tempo real: relê a disponibilidade no Pulse Direct a cada 30s
  await svc.syncIfStale(30_000);
  const fromTs = dayStart(todayKey());
  const [users, ivs, departments, recent] = await Promise.all([
    sql`SELECT * FROM users WHERE active AND crm_user_id IS NOT NULL ORDER BY name`,
    loadIntervals(fromTs, fromTs + DAY),
    departmentsMap(),
    // períodos das últimas 48h para calcular o início de cada jornada aberta
    sql`SELECT user_id, started_at, ended_at FROM intervals WHERE started_at >= ${Date.now() - 2 * DAY} OR ended_at IS NULL ORDER BY started_at DESC`,
  ]);
  const sums = summarize(ivs, fromTs, fromTs + DAY);
  const open = new Map((await sql`SELECT * FROM intervals WHERE ended_at IS NULL`).map((i) => [i.user_id, i]));
  const recentBy = new Map();
  for (const r of recent) (recentBy.get(r.user_id) || recentBy.set(r.user_id, []).get(r.user_id)).push(r);
  res.json({
    serverNow: Date.now(),
    departments,
    members: users.map((u) => {
      const cur = open.get(u.id);
      const t = sums.get(u.id)?.total;
      return {
        ...auth.publicUser(u),
        state: cur ? cur.kind : 'offline',
        current: currentView(cur),
        shiftStartedAt: shiftStartFrom(recentBy.get(u.id) || [], cur),
        today: t ? { active: t.active, pause: t.pause, pauses: t.pauses, overLimit: t.overLimit } : null,
        registered: !!u.password_hash,
      };
    }),
  });
}));

const targetUser = async (req) => {
  const id = Number(req.params.id);
  const [u] = Number.isInteger(id) ? await sql`SELECT * FROM users WHERE id = ${id} AND active` : [];
  if (!u) throw svc.httpErr(404, 'Usuário não encontrado.');
  return u;
};
admin.post('/users/:id/start', action(async (req) => svc.startShift(await targetUser(req), req.user.id)));
admin.post('/users/:id/pause', action(async (req) => svc.startPause(await targetUser(req), req.body.reasonId, req.body.note, req.user.id)));
admin.post('/users/:id/resume', action(async (req) => svc.endPause(await targetUser(req), req.user.id)));
admin.post('/users/:id/end', action(async (req) => svc.endShift(await targetUser(req), req.user.id)));
admin.get('/users/:id/stats', wrap(async (req, res) => {
  const u = await targetUser(req);
  res.json({ user: auth.publicUser(u), ...(await userStats(u.id, req.query)) });
}));

async function buildReport(q) {
  const r = parseRange(q, 7);
  let users = await sql`SELECT * FROM users WHERE crm_user_id IS NOT NULL ORDER BY name`;
  if (q.department) users = users.filter((u) => u.departments.includes(q.department));
  const ivs = await loadIntervals(r.fromTs, r.toTs, users.map((u) => u.id));
  const sums = summarize(ivs, r.fromTs, r.toTs);
  const byReason = {};
  const rows = users
    .map((u) => {
      const s = sums.get(u.id);
      if (!s && !u.active) return null;
      if (s) for (const [k, v] of Object.entries(s.total.byReason)) byReason[k] = (byReason[k] || 0) + v;
      return { ...auth.publicUser(u), total: s?.total || null, daysWorked: s ? [...s.days.values()].filter((d) => d.active + d.pause > 0).length : 0, days: s ? daysToArray(s.days) : [] };
    })
    .filter(Boolean);
  return { from: r.from, to: r.to, rows, byReason, pauses: ivs.filter((i) => i.kind === 'pause' && i.started_at >= r.fromTs) };
}

admin.get('/report', wrap(async (req, res) => {
  const rep = await buildReport(req.query);
  res.json({ from: rep.from, to: rep.to, rows: rep.rows.map(({ days, ...x }) => x), byReason: rep.byReason, departments: await departmentsMap() });
}));

const TZ_MS = Number(process.env.TZ_OFFSET_MINUTES ?? -180) * 60000;
const fmtDur = (ms) => {
  const m = Math.round((ms || 0) / 60000);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const fmtDate = (k) => k.split('-').reverse().join('/');
const fmtTs = (ts) => (ts ? new Date(ts + TZ_MS).toISOString().slice(0, 19).replace('T', ' ').replace(/^(\d+)-(\d+)-(\d+)/, '$3/$2/$1') : '');
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
};

admin.get('/report.csv', wrap(async (req, res) => {
  const rep = await buildReport(req.query);
  const reasons = Object.keys(rep.byReason).sort();
  let lines;
  if (req.query.type === 'pauses') {
    const users = new Map(rep.rows.map((u) => [u.id, u]));
    lines = [['Atendente', 'E-mail', 'Motivo', 'Início', 'Fim', 'Duração (hh:mm)', 'Limite (min)', 'Acima do limite', 'Observação']];
    for (const p of rep.pauses) {
      const u = users.get(p.user_id);
      if (!u) continue;
      const dur = (p.ended_at ?? Date.now()) - p.started_at;
      lines.push([u.name, u.email, p.reason_name, fmtTs(p.started_at), p.ended_at ? fmtTs(p.ended_at) : 'Em andamento', fmtDur(dur), p.max_minutes ?? '', p.max_minutes && dur > p.max_minutes * 60000 ? 'Sim' : 'Não', p.note || '']);
    }
  } else {
    lines = [['Atendente', 'E-mail', 'Data', 'Início', 'Fim', 'Tempo ativo (hh:mm)', 'Tempo em pausa (hh:mm)', 'Qtd. pausas', 'Pausas acima do limite', ...reasons.map((r) => `Pausa: ${r}`)]];
    for (const u of rep.rows) {
      for (const d of [...u.days].reverse()) {
        lines.push([u.name, u.email, fmtDate(d.date), fmtTs(d.first).slice(11, 16), fmtTs(d.last).slice(11, 16), fmtDur(d.active), fmtDur(d.pause), d.pauses, d.overLimit, ...reasons.map((r) => fmtDur(d.byReason[r]))]);
      }
    }
  }
  const csv = '﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="pausas_${req.query.type === 'pauses' ? 'detalhado' : 'diario'}_${rep.from}_a_${rep.to}.csv"`);
  res.send(csv);
}));

// Motivos de pausa
admin.get('/reasons', wrap(async (req, res) => res.json(await sql`SELECT * FROM pause_reasons ORDER BY active DESC, sort, name`)));

function reasonInput(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw svc.httpErr(400, 'Informe o nome do motivo.');
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#f59e0b';
  const max = b.maxMinutes === '' || b.maxMinutes == null ? null : Math.max(1, Math.min(1440, Math.round(Number(b.maxMinutes))));
  if (Number.isNaN(max)) throw svc.httpErr(400, 'Limite inválido.');
  return { name, color, max };
}
admin.post('/reasons', wrap(async (req, res) => {
  const r = reasonInput(req.body);
  await sql`INSERT INTO pause_reasons (name, color, max_minutes, sort)
    VALUES (${r.name}, ${r.color}, ${r.max}, (SELECT COALESCE(MAX(sort), 0) + 1 FROM pause_reasons))`;
  await audit(req.user.id, null, 'reason_create', r);
  res.json({ ok: true });
}));
admin.put('/reasons/:id', wrap(async (req, res) => {
  const r = reasonInput(req.body);
  const active = req.body.active !== false;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw svc.httpErr(400, 'Motivo inválido.');
  await sql`UPDATE pause_reasons SET name = ${r.name}, color = ${r.color}, max_minutes = ${r.max}, active = ${active} WHERE id = ${id}`;
  await audit(req.user.id, null, 'reason_update', { id, ...r, active });
  res.json({ ok: true });
}));

// Usuários e papéis
admin.get('/users', wrap(async (req, res) => {
  await svc.syncIfStale();
  const [users, departments, lastSync] = await Promise.all([
    sql`SELECT * FROM users WHERE active ORDER BY role DESC, name`,
    departmentsMap(),
    getMeta('last_sync'),
  ]);
  res.json({
    lastSync: Number(lastSync) || null,
    departments,
    users: users.map((u) => ({ ...auth.publicUser(u), registered: !!u.password_hash, lastLoginAt: u.last_login_at })),
  });
}));
admin.put('/users/:id/role', wrap(async (req, res) => {
  const u = await targetUser(req);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (u.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'Você não pode remover seu próprio acesso de administrador.' });
  if (role === 'user' && svc.adminEmails().includes(u.email)) {
    return res.status(400).json({ error: 'Este administrador está definido na configuração do servidor (ADMIN_EMAILS).' });
  }
  await sql`UPDATE users SET role = ${role}, updated_at = ${Date.now()} WHERE id = ${u.id}`;
  await audit(req.user.id, u.id, 'role', { role });
  res.json({ ok: true });
}));
admin.post('/users/:id/reset-password', wrap(async (req, res) => {
  const u = await targetUser(req);
  await sql`UPDATE users SET password_hash = NULL, updated_at = ${Date.now()} WHERE id = ${u.id}`;
  await auth.destroyUserSessions(u.id);
  await audit(req.user.id, u.id, 'reset_password');
  res.json({ ok: true });
}));
admin.post('/sync', wrap(async (req, res) => res.json(await svc.syncUsers())));

// Distribuição automática (aba /distribuicao)
admin.use('/distribuicao', distribuicaoAdmin);

api.use('/admin', admin);
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500 && status !== 502) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Erro interno. Tente novamente.' : err.message });
});
