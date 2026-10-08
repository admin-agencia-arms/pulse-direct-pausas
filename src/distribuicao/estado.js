// Estado da distribuição no Postgres (tabelas dist_* do db/distribuicao.sql).
// Serverless: cada execução lê daqui e grava aqui; nada fica só na memória do processo.
import { readFileSync } from 'node:fs';

const ABERTOS = ['STARTED', 'PENDING', 'IN_PROGRESS'];
const DIA = 86_400_000;
const LOTE = 500;

export function criarEstado(sql) {
  const abertos = sql.array(ABERTOS);

  return {
    /** As tabelas existem? Se não, tenta criá-las (funciona quando o usuário do banco tem permissão). */
    async preparar() {
      const [r] = await sql`SELECT to_regclass('dist_estado') IS NOT NULL AS ok`;
      if (r.ok) return { ok: true };
      try {
        await sql.unsafe(readFileSync(new URL('../../db/distribuicao.sql', import.meta.url), 'utf8'));
        return { ok: true, criado: true };
      } catch (e) {
        return { ok: false, erro: `Banco ainda não preparado: rode db/distribuicao.sql como owner do banco (${e.message}).` };
      }
    },

    // ---------- chave → valor ----------

    // Cada valor vai num envelope {v}: assim null também é um valor válido (a coluna é NOT NULL).
    async lerEstado(chaves) {
      const linhas = chaves
        ? await sql`SELECT chave, valor FROM dist_estado WHERE chave = ANY(${sql.array(chaves)})`
        : await sql`SELECT chave, valor FROM dist_estado`;
      return Object.fromEntries(linhas.map((l) => [l.chave, l.valor?.v ?? null]));
    },

    async gravarEstado(valores, agora = Date.now()) {
      const linhas = Object.entries(valores).filter(([, v]) => v !== undefined)
        .map(([chave, valor]) => ({ chave, valor: sql.json({ v: valor }), atualizado_em: agora }));
      if (!linhas.length) return;
      await sql`INSERT INTO dist_estado ${sql(linhas, 'chave', 'valor', 'atualizado_em')}
        ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`;
    },

    // ---------- travas com validade ----------

    async adquirirTrava(nome, dono, agora, validadeMs) {
      const r = await sql`INSERT INTO dist_trava (nome, dono, expira_em) VALUES (${nome}, ${dono}, ${agora + validadeMs})
        ON CONFLICT (nome) DO UPDATE SET dono = excluded.dono, expira_em = excluded.expira_em
        WHERE dist_trava.dono = excluded.dono OR dist_trava.expira_em < ${agora}
        RETURNING nome`;
      return r.length > 0;
    },

    async liberarTrava(nome, dono) {
      await sql`DELETE FROM dist_trava WHERE nome = ${nome} AND dono = ${dono}`;
    },

    async travaAtiva(nome, agora) {
      const [r] = await sql`SELECT 1 FROM dist_trava WHERE nome = ${nome} AND expira_em >= ${agora}`;
      return Boolean(r);
    },

    // ---------- conversas ----------

    /**
     * Grava conversas lidas do Pulse Direct. Leitura velha não sobrescreve uma mais nova (alterada_us).
     * `leitura` marca as vistas numa releitura completa. Descarta o que não interessa mais.
     */
    async aplicarConversas(lista, { inicioDia, leitura = null }) {
      for (let i = 0; i < lista.length; i += LOTE) {
        const linhas = lista.slice(i, i + LOTE).map((c) => ({
          id: c.id, status: c.status, equipe_id: c.equipeId, user_id: c.userId, criada_em: c.criadaEm,
          alterada_us: c.alteradaUs ?? 0, encerrada_em: c.encerradaEm, tipo: c.tipo, leitura,
        }));
        await sql`INSERT INTO dist_conversas ${sql(linhas, 'id', 'status', 'equipe_id', 'user_id', 'criada_em', 'alterada_us', 'encerrada_em', 'tipo', 'leitura')}
          ON CONFLICT (id) DO UPDATE SET
            status = excluded.status, equipe_id = excluded.equipe_id, user_id = excluded.user_id,
            criada_em = COALESCE(excluded.criada_em, dist_conversas.criada_em), alterada_us = excluded.alterada_us,
            encerrada_em = excluded.encerrada_em, tipo = excluded.tipo,
            leitura = COALESCE(excluded.leitura, dist_conversas.leitura)
          WHERE dist_conversas.alterada_us <= excluded.alterada_us`;
        const ids = sql.array(linhas.map((l) => l.id));
        await sql`DELETE FROM dist_conversas WHERE id = ANY(${ids})
          AND NOT (status = ANY(${abertos}) OR (status = 'COMPLETED' AND encerrada_em >= ${inicioDia}))`;
      }
    },

    async obterConversas(ids) {
      if (!ids.length) return new Map();
      const linhas = await sql`SELECT id, status, equipe_id, user_id FROM dist_conversas WHERE id = ANY(${sql.array(ids)})`;
      return new Map(linhas.map((l) => [l.id, l]));
    },

    async marcarAtribuida(id, userId) {
      await sql`UPDATE dist_conversas SET user_id = ${userId} WHERE id = ${id}`;
    },

    async removerConversa(id) {
      await sql`DELETE FROM dist_conversas WHERE id = ${id}`;
    },

    /** Abertas com dono, por atendente, equipe e status. */
    carga() {
      return sql`SELECT user_id, equipe_id, status, count(*)::int AS n FROM dist_conversas
        WHERE user_id IS NOT NULL AND status = ANY(${abertos}) GROUP BY 1, 2, 3`;
    },

    /** Esperando na fila de uma equipe, sem atendente. */
    fila() {
      return sql`SELECT id, equipe_id, criada_em FROM dist_conversas
        WHERE status = 'PENDING' AND user_id IS NULL AND equipe_id IS NOT NULL AND tipo IS DISTINCT FROM 'GROUP'`;
    },

    concluidasHoje(inicioDia) {
      return sql`SELECT user_id, count(*)::int AS n FROM dist_conversas
        WHERE status = 'COMPLETED' AND encerrada_em >= ${inicioDia} AND user_id IS NOT NULL GROUP BY 1`;
    },

    async ausentes(leitura, limite) {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM dist_conversas WHERE status = ANY(${abertos}) AND leitura IS DISTINCT FROM ${leitura}`;
      const ids = await sql`SELECT id FROM dist_conversas WHERE status = ANY(${abertos}) AND leitura IS DISTINCT FROM ${leitura} LIMIT ${limite}`;
      return { total: n, ids: ids.map((r) => r.id) };
    },

    /** Abertas que a leitura completa `rodada` viu (para a autoconferência). */
    contarLidas(rodada) {
      return sql`SELECT count(*)::int AS n FROM dist_conversas WHERE status = ANY(${abertos}) AND leitura = ${rodada}`;
    },

    async totalConversas() {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM dist_conversas`;
      return n;
    },

    /** Virada do dia: tira as concluídas de ontem. */
    async podarConversas(inicioDia) {
      await sql`DELETE FROM dist_conversas WHERE NOT (status = ANY(${abertos}) OR (status = 'COMPLETED' AND encerrada_em >= ${inicioDia}))`;
    },

    // ---------- simulação ----------

    async simulacoes() {
      return new Map((await sql`SELECT conversa_id, user_id FROM dist_simulacao`).map((r) => [r.conversa_id, r.user_id]));
    },

    async gravarSimulacao(conversaId, userId, em) {
      await sql`INSERT INTO dist_simulacao (conversa_id, user_id, em) VALUES (${conversaId}, ${userId}, ${em})
        ON CONFLICT (conversa_id) DO UPDATE SET user_id = excluded.user_id, em = excluded.em`;
    },

    async removerSimulacoes(ids) {
      if (ids.length) await sql`DELETE FROM dist_simulacao WHERE conversa_id = ANY(${sql.array(ids)})`;
    },

    // ---------- histórico ----------

    async registrarDecisao(d) {
      await sql`INSERT INTO dist_decisoes (em, modo, conversa_id, equipe_id, equipe, user_id, atendente, carga_antes, resultado, detalhe)
        VALUES (${d.em}, ${d.modo}, ${d.conversaId}, ${d.equipeId ?? null}, ${d.equipe ?? null}, ${d.userId ?? null},
          ${d.atendente ?? null}, ${d.cargaAntes ?? 0}, ${d.resultado}, ${d.detalhe ?? null})`;
    },

    ultimasDecisoes(limite = 100) {
      return sql`SELECT em, modo, conversa_id AS "conversaId", equipe_id AS "equipeId", equipe, user_id AS "userId", atendente,
        carga_antes AS "cargaAntes", resultado, detalhe FROM dist_decisoes ORDER BY id DESC LIMIT ${limite}`;
    },

    async ultimasEntregas(desde) {
      const linhas = await sql`SELECT user_id, max(em) AS em FROM dist_decisoes
        WHERE em >= ${desde} AND resultado = 'atribuido' GROUP BY 1`;
      return new Map(linhas.map((l) => [l.user_id, Number(l.em)]));
    },

    async registrarEvento(e) {
      await sql`INSERT INTO dist_eventos (em, nivel, tipo, mensagem, dados)
        VALUES (${e.em}, ${e.nivel}, ${e.tipo}, ${e.mensagem}, ${e.dados ? sql.json(e.dados) : null})`;
    },

    ultimosEventos(limite = 200) {
      return sql`SELECT em, nivel, tipo, mensagem FROM dist_eventos ORDER BY id DESC LIMIT ${limite}`;
    },

    async usoRecente(desde) {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM dist_chamadas WHERE em >= ${desde}`;
      return n;
    },

    async registrarChamada(c) {
      await sql`INSERT INTO dist_chamadas (em, metodo, caminho, status, duracao_ms, tentativa)
        VALUES (${c.em}, ${c.metodo}, ${c.caminho.slice(0, 500)}, ${c.status}, ${c.duracaoMs}, ${c.tentativa})`;
    },

    async instantesChamadas(desde) {
      return (await sql`SELECT em FROM dist_chamadas WHERE em >= ${desde} ORDER BY em`).map((l) => Number(l.em));
    },

    async registrarCiclo(c) {
      await sql`INSERT INTO dist_ciclos (em, origem, duracao_ms, requisicoes, decisoes, erro)
        VALUES (${c.em}, ${c.origem}, ${c.duracaoMs}, ${c.requisicoes}, ${c.decisoes}, ${c.erro ?? null})`;
    },

    /** Retenção: decisões 90 dias, eventos 30, ciclos 7, chamadas 3. */
    async podar(agora) {
      await sql`DELETE FROM dist_decisoes WHERE em < ${agora - 90 * DIA}`;
      await sql`DELETE FROM dist_eventos WHERE em < ${agora - 30 * DIA}`;
      await sql`DELETE FROM dist_ciclos WHERE em < ${agora - 7 * DIA}`;
      await sql`DELETE FROM dist_chamadas WHERE em < ${agora - 3 * DIA}`;
      await sql`DELETE FROM dist_simulacao WHERE em < ${agora - 2 * DIA}`;
    },
  };
}
