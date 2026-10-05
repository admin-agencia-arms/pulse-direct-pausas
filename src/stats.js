import { sql } from './db.js';

const OFFSET = Number(process.env.TZ_OFFSET_MINUTES ?? -180) * 60_000;
export const DAY = 86_400_000;

/** 'YYYY-MM-DD' no fuso configurado */
export const dayKey = (ts) => new Date(ts + OFFSET).toISOString().slice(0, 10);
/** início do dia (epoch ms) no fuso configurado */
export const dayStart = (key) => Date.parse(`${key}T00:00:00Z`) - OFFSET;
export const todayKey = () => dayKey(Date.now());
export const isDayKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(Date.parse(k));

export function parseRange(q, defaultDays = 7) {
  const to = isDayKey(q.to) ? q.to : todayKey();
  const from = isDayKey(q.from) ? q.from : dayKey(dayStart(to) - (defaultDays - 1) * DAY);
  if (from > to) throw Object.assign(new Error('Período inválido.'), { status: 400 });
  if ((dayStart(to) - dayStart(from)) / DAY > 186) {
    throw Object.assign(new Error('Período máximo de 6 meses.'), { status: 400 });
  }
  return { from, to, fromTs: dayStart(from), toTs: dayStart(to) + DAY };
}

export async function loadIntervals(fromTs, toTs, userIds = null) {
  if (userIds && !userIds.length) return [];
  return sql`
    SELECT * FROM intervals
    WHERE started_at < ${toTs} AND (ended_at IS NULL OR ended_at > ${fromTs})
    ${userIds ? sql`AND user_id = ANY(${userIds}::int[])` : sql``}
    ORDER BY started_at`;
}

const blank = () => ({ active: 0, pause: 0, pauses: 0, overLimit: 0, byReason: {}, first: null, last: null });

function add(row, iv, s, e) {
  const ms = e - s;
  if (iv.kind === 'active') row.active += ms;
  else {
    row.pause += ms;
    const r = iv.reason_name || 'Sem motivo';
    row.byReason[r] = (row.byReason[r] || 0) + ms;
  }
  row.first = row.first == null ? s : Math.min(row.first, s);
  row.last = Math.max(row.last ?? 0, e);
}

/**
 * Agrega períodos por usuário e por dia (cortando nos limites de cada dia).
 * Retorna Map(userId -> { total, days: Map(dayKey -> row) })
 */
export function summarize(intervals, fromTs, toTs, now = Date.now()) {
  const out = new Map();
  const get = (uid) => {
    let u = out.get(uid);
    if (!u) out.set(uid, (u = { total: blank(), days: new Map() }));
    return u;
  };
  const getDay = (u, k) => {
    let d = u.days.get(k);
    if (!d) u.days.set(k, (d = blank()));
    return d;
  };
  for (const iv of intervals) {
    const s = Math.max(iv.started_at, fromTs);
    const e = Math.min(iv.ended_at ?? now, toTs, now);
    const u = get(iv.user_id);
    for (let cur = s; cur < e; ) {
      const k = dayKey(cur);
      const next = Math.min(dayStart(k) + DAY, e);
      add(getDay(u, k), iv, cur, next);
      add(u.total, iv, cur, next);
      cur = next;
    }
    if (iv.kind === 'pause' && iv.started_at >= fromTs && iv.started_at < toTs) {
      const d = getDay(u, dayKey(iv.started_at));
      const dur = (iv.ended_at ?? now) - iv.started_at;
      const over = iv.max_minutes && dur > iv.max_minutes * 60_000 ? 1 : 0;
      d.pauses++; u.total.pauses++;
      d.overLimit += over; u.total.overLimit += over;
    }
  }
  return out;
}

export function daysToArray(days) {
  return [...days.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).map(([date, r]) => ({ date, ...r }));
}
