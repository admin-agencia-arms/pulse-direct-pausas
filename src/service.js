import { sql, audit, getMeta, setMeta } from './db.js';
import * as crm from './crm.js';
import { normEmail } from './auth.js';

const OFFLINE_STATUS = process.env.OFFLINE_STATUS === 'Active' ? 'Active' : 'Blocked';
const SYNC_MS = Math.max(1, Number(process.env.SYNC_MINUTES || 10)) * 60_000;

export const httpErr = (status, message) => Object.assign(new Error(message), { status });

export async function openInterval(userId) {
  const [r] = await sql`SELECT * FROM intervals WHERE user_id = ${userId} AND ended_at IS NULL ORDER BY id DESC LIMIT 1`;
  return r ?? null;
}

export async function stateOf(userId) {
  const cur = await openInterval(userId);
  return { state: cur ? cur.kind : 'offline', current: cur };
}

// Trava por usuário no banco (vale entre instâncias serverless). Expira sozinha em 30s.
async function locked(user, fn) {
  if (!user.crm_user_id) throw httpErr(400, 'Este usuário não é um atendente do Pulse Direct.');
  const t = Date.now();
  const [got] = await sql`UPDATE users SET busy_until = ${t + 30_000}
    WHERE id = ${user.id} AND (busy_until IS NULL OR busy_until < ${t}) RETURNING id`;
  if (!got) throw httpErr(409, 'Já existe uma alteração em andamento. Aguarde.');
  try {
    return await fn();
  } finally {
    await sql`UPDATE users SET busy_until = NULL WHERE id = ${user.id}`;
  }
}

async function pushStatus(user, status) {
  try {
    await crm.setAgentStatus(user, status);
  } catch (e) {
    throw httpErr(502, `Não foi possível alterar o status no Pulse Direct: ${e.message}`);
  }
}

const openNew = (q, userId, kind, reason, note, t, actorId) => q`
  INSERT INTO intervals (user_id, kind, reason_id, reason_name, max_minutes, note, started_at, started_by)
  VALUES (${userId}, ${kind}, ${reason?.id ?? null}, ${reason?.name ?? null}, ${reason?.max_minutes ?? null}, ${note ?? null}, ${t}, ${actorId})`;
const closeIt = (q, id, t, actorId) => q`UPDATE intervals SET ended_at = ${t}, ended_by = ${actorId} WHERE id = ${id} AND ended_at IS NULL`;

export const startShift = (user, actorId) => locked(user, async () => {
  if (await openInterval(user.id)) throw httpErr(409, 'A jornada já está iniciada.');
  await pushStatus(user, 'Active');
  await openNew(sql, user.id, 'active', null, null, Date.now(), actorId);
  await audit(actorId, user.id, 'start_shift');
});

export const startPause = (user, reasonId, note, actorId) => locked(user, async () => {
  const cur = await openInterval(user.id);
  if (!cur) throw httpErr(409, 'Inicie a jornada antes de pausar.');
  if (cur.kind === 'pause') throw httpErr(409, 'Você já está em pausa.');
  const id = Number(reasonId);
  const [reason] = Number.isInteger(id) ? await sql`SELECT * FROM pause_reasons WHERE id = ${id} AND active` : [];
  if (!reason) throw httpErr(400, 'Selecione um motivo de pausa válido.');
  const cleanNote = note ? String(note).trim().slice(0, 300) || null : null;
  await pushStatus(user, 'Blocked');
  const t = Date.now();
  await sql.begin(async (q) => {
    await closeIt(q, cur.id, t, actorId);
    await openNew(q, user.id, 'pause', reason, cleanNote, t, actorId);
  });
  await audit(actorId, user.id, 'start_pause', { reason: reason.name });
});

export const endPause = (user, actorId) => locked(user, async () => {
  const cur = await openInterval(user.id);
  if (!cur || cur.kind !== 'pause') throw httpErr(409, 'Não há pausa em andamento.');
  await pushStatus(user, 'Active');
  const t = Date.now();
  await sql.begin(async (q) => {
    await closeIt(q, cur.id, t, actorId);
    await openNew(q, user.id, 'active', null, null, t, actorId);
  });
  await audit(actorId, user.id, 'end_pause', { reason: cur.reason_name });
});

export const endShift = (user, actorId) => locked(user, async () => {
  const cur = await openInterval(user.id);
  if (!cur) throw httpErr(409, 'A jornada não está iniciada.');
  await pushStatus(user, OFFLINE_STATUS);
  await closeIt(sql, cur.id, Date.now(), actorId);
  await audit(actorId, user.id, 'end_shift');
});

// ---------- Sincronização de usuários ----------

export function adminEmails() {
  return (process.env.ADMIN_EMAILS || '').split(',').map(normEmail).filter(Boolean);
}

let syncing = null;
export function syncUsers() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

/** Sincroniza se a última sincronização for mais antiga que maxAge (padrão SYNC_MINUTES). Nunca lança erro. */
export async function syncIfStale(maxAge = SYNC_MS) {
  try {
    const last = Number(await getMeta('last_sync')) || 0;
    if (Date.now() - last > maxAge) await syncUsers();
  } catch (e) {
    console.error('[sync] falhou:', e.message);
  }
}

// ---------- Reconciliação com a disponibilidade no Pulse Direct ----------
// O Pulse Direct é a fonte da verdade sobre a disponibilidade. Se o atendente ficou
// disponível/indisponível por fora da plataforma, ajustamos os períodos aqui.

const SETTLE_MS = 5_000;
const CRM_GRACE_MS = 30_000;

/** Horário da mudança informado pelo Pulse Direct (updatedAt), se for plausível; senão, agora. */
function changeTime(agent, after, now) {
  const ts = Date.parse(agent.updatedAt || '');
  return Number.isFinite(ts) && ts > after && ts < now ? ts : now;
}

export async function reconcile(agents, fetchedAt) {
  const list = agents.filter((a) => a?.userId && a.availability);
  if (!list.length) return { changed: 0 };
  const byCrm = new Map(list.map((a) => [a.userId, a]));
  const users = await sql`
    SELECT u.id, u.crm_user_id, u.busy_until,
      (SELECT row_to_json(i) FROM intervals i WHERE i.user_id = u.id AND i.ended_at IS NULL LIMIT 1) AS open,
      (SELECT MAX(GREATEST(i.started_at, COALESCE(i.ended_at, 0))) FROM intervals i WHERE i.user_id = u.id) AS last_change
    FROM users u WHERE u.active AND u.crm_user_id = ANY(${[...byCrm.keys()]}::text[])`;

  const now = Date.now();
  await sql`UPDATE users SET crm_availability = v.av, crm_checked_at = ${now}
    FROM (SELECT unnest(${users.map((u) => u.id)}::int[]) AS id, unnest(${users.map((u) => byCrm.get(u.crm_user_id).availability)}::text[]) AS av) v
    WHERE users.id = v.id`;

  const todayStart = now - ((now + Number(process.env.TZ_OFFSET_MINUTES ?? -180) * 60_000) % 86_400_000);
  let changed = 0;
  for (const u of users) {
    const a = byCrm.get(u.crm_user_id);
    const available = a.availability === 'AVAILABLE';
    const open = u.open;
    const last = Number(u.last_change) || 0;
    // não mexe em quem está com uma ação em andamento ou mudou depois da leitura do Pulse Direct
    if ((u.busy_until && u.busy_until > now) || last > fetchedAt - SETTLE_MS) continue;
    // só ajusta se a mudança no Pulse Direct for posterior à última ação feita aqui
    // (evita desfazer uma pausa/jornada que o Pulse Direct ainda não refletiu)
    const crmTs = Date.parse(a.updatedAt || '');
    if (last && !(crmTs > last + CRM_GRACE_MS)) continue;
    try {
      if (available && !open) {
        const t = changeTime(a, Math.max(last, todayStart), now);
        await openNew(sql, u.id, 'active', null, null, t, null);
        await audit(null, u.id, 'crm_available', { at: t });
        changed++;
      } else if (available && open?.kind === 'pause') {
        const t = changeTime(a, open.started_at, now);
        await sql.begin(async (q) => {
          await closeIt(q, open.id, t, null);
          await openNew(q, u.id, 'active', null, null, t, null);
        });
        await audit(null, u.id, 'crm_available', { at: t, closedPause: open.reason_name });
        changed++;
      } else if (!available && open?.kind === 'active') {
        const t = changeTime(a, open.started_at, now);
        await closeIt(sql, open.id, t, null);
        await audit(null, u.id, 'crm_unavailable', { at: t });
        changed++;
      }
    } catch (e) {
      console.error('[reconcile]', u.id, e.message);
    }
  }
  return { changed };
}

/** Verifica um único atendente no Pulse Direct (usado pelo painel do próprio atendente). */
export async function reconcileUser(user, maxAge = 60_000) {
  if (!user.crm_user_id || Date.now() - (Number(user.crm_checked_at) || 0) < maxAge) return;
  try {
    const fetchedAt = Date.now();
    const agent = await crm.getAgent(user.crm_user_id);
    await reconcile([agent], fetchedAt);
  } catch (e) {
    console.error('[reconcile] falhou:', e.message);
  }
}

const sameArr = (a, b) => (a || []).join(',') === (b || []).join(',');

async function doSync() {
  const fetchedAt = Date.now();
  const [agents, departments] = await Promise.all([
    crm.listAgents(),
    crm.listDepartments().catch(() => []),
  ]);
  if (!Array.isArray(agents)) throw new Error('Resposta inesperada ao listar atendentes.');
  const t = Date.now();
  const stats = { total: 0, created: 0, updated: 0, deactivated: 0, skipped: 0 };

  const existing = await sql`SELECT id, email, name, crm_user_id, crm_agent_id, profile, departments, active FROM users`;
  const byCrm = new Map(existing.filter((u) => u.crm_user_id).map((u) => [u.crm_user_id, u]));
  const byEmail = new Map(existing.map((u) => [u.email, u]));

  const inserts = [];
  const updates = [];
  const seen = [];
  const seenEmails = new Set();

  for (const a of agents) {
    const email = normEmail(a.email);
    if (!email || !a.userId || seenEmails.has(email)) { stats.skipped++; continue; }
    seenEmails.add(email);
    seen.push(a.userId);
    stats.total++;
    const deps = [...new Set((a.departments || []).map((d) => d.departmentId).filter(Boolean))].sort();
    const name = (a.name || a.shortName || '').trim() || null;
    let row = byCrm.get(a.userId);
    if (!row) {
      const e = byEmail.get(email);
      if (e && (!e.crm_user_id || e.crm_user_id === a.userId)) row = e;
    }
    const clash = byEmail.get(email);
    if (clash && (!row || clash.id !== row.id)) { stats.skipped++; continue; }
    const next = { email, name, crm_user_id: a.userId, crm_agent_id: a.id, profile: a.profile || null, departments: deps };
    if (row) {
      const changed = row.email !== email || row.name !== name || row.crm_user_id !== a.userId || row.crm_agent_id !== a.id
        || row.profile !== next.profile || !sameArr(row.departments, deps) || !row.active;
      if (changed) {
        updates.push({ id: row.id, ...next });
        stats.updated++;
      }
    } else {
      inserts.push({ ...next, created_at: t, updated_at: t });
      stats.created++;
    }
  }

  await sql.begin(async (q) => {
    const deps = (Array.isArray(departments) ? departments : []).filter((d) => d?.id).map((d) => ({ id: d.id, name: d.name || 'Equipe' }));
    if (deps.length) {
      await q`INSERT INTO departments ${q(deps, 'id', 'name')} ON CONFLICT (id) DO UPDATE SET name = excluded.name`;
    }
    for (const u of updates) {
      await q`UPDATE users SET email = ${u.email}, name = ${u.name}, crm_user_id = ${u.crm_user_id}, crm_agent_id = ${u.crm_agent_id},
        profile = ${u.profile}, departments = ${u.departments}::text[], active = true, updated_at = ${t} WHERE id = ${u.id}`;
    }
    if (inserts.length) {
      await q`INSERT INTO users ${q(inserts, 'email', 'name', 'crm_user_id', 'crm_agent_id', 'profile', 'departments', 'created_at', 'updated_at')}`;
    }
    // Atendentes removidos do Pulse Direct perdem o acesso (o histórico é mantido)
    const gone = await q`UPDATE users SET active = false, updated_at = ${t}
      WHERE crm_user_id IS NOT NULL AND active AND NOT (crm_user_id = ANY(${seen}::text[])) RETURNING id`;
    if (gone.length) await q`DELETE FROM sessions WHERE user_id = ANY(${gone.map((g) => g.id)}::int[])`;
    stats.deactivated = gone.length;
  });

  await ensureAdmins(t);
  const { changed } = await reconcile(agents, fetchedAt);
  await setMeta('last_sync', t);
  return { ...stats, statusAdjusted: changed, at: t };
}

export async function ensureAdmins(t = Date.now()) {
  for (const email of adminEmails()) {
    await sql`INSERT INTO users (email, name, role, created_at, updated_at)
      VALUES (${email}, ${email.split('@')[0]}, 'admin', ${t}, ${t})
      ON CONFLICT (email) DO UPDATE SET role = 'admin'`;
  }
}
