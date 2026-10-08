import postgres from 'postgres';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');

// Pooler em modo transação: sem prepared statements e sem pipelining (o pooler
// trava com várias consultas pipelined na mesma conexão). O search_path (schema
// "pausas") vem da configuração do usuário de banco.
export const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  max_pipeline: 1,
  // DB_SSL=disable só para banco local de desenvolvimento/testes
  ssl: process.env.DB_SSL === 'disable' ? false : 'require',
  max: Number(process.env.DB_POOL_MAX || 4),
  idle_timeout: 20,
  connect_timeout: 10,
  types: {
    bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) },
  },
});

export async function audit(actorId, targetId, action, detail) {
  await sql`INSERT INTO audit (at, actor_id, target_id, action, detail)
    VALUES (${Date.now()}, ${actorId ?? null}, ${targetId ?? null}, ${action}, ${detail ? sql.json(detail) : null})`;
}

export async function getMeta(key) {
  const [r] = await sql`SELECT value FROM meta WHERE key = ${key}`;
  return r?.value ?? null;
}

export async function setMeta(key, value) {
  await sql`INSERT INTO meta (key, value) VALUES (${key}, ${String(value)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
}
