// Apoio aos testes da distribuição. Usam um Postgres LOCAL (nunca o de produção) e um Pulse Direct falso.
//   DATABASE_URL_TESTE=postgres://pausas_app:SENHA@localhost:5432/pausas_teste npm test
// O banco de teste precisa do db/schema.sql e do db/distribuicao.sql aplicados.
import { PulseFalso } from './pulse-falso.js';

export const TEM_BANCO = Boolean(process.env.DATABASE_URL_TESTE);

const TABELAS = ['dist_conversas', 'dist_estado', 'dist_trava', 'dist_simulacao', 'dist_decisoes', 'dist_eventos', 'dist_chamadas', 'dist_ciclos'];

let modulos = null;

/** Liga o app ao banco de teste (só se for local) e carrega os módulos que dependem dele. */
export async function preparar() {
  if (modulos) return modulos;
  const url = new URL(process.env.DATABASE_URL_TESTE);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`Os testes só rodam em banco local (veio ${url.hostname}).`);
  }
  process.env.DATABASE_URL = process.env.DATABASE_URL_TESTE;
  process.env.DB_SSL = 'disable';
  const { sql } = await import('../src/db.js');
  const rotas = await import('../src/distribuicao/rotas.js');
  modulos = { sql, ...rotas };
  return modulos;
}

/** Fecha as conexões no fim do arquivo de teste (senão o processo espera o pool expirar). */
export async function encerrar() {
  if (!modulos) return;
  await modulos.aguardarSegundoPlano();
  await modulos.sql.end({ timeout: 1 });
}

export async function limpar(sql) {
  for (const t of TABELAS) await sql.unsafe(`DELETE FROM ${t}`);
}

/** Pulse Direct falso no ar + distribuidor ligado nele (sem espera entre chamadas). */
export async function cenario({ configurar, env = {}, agora, dormir, relogioLimitador } = {}) {
  const { sql, criarDistribuidor } = await preparar();
  await limpar(sql);
  const pulse = new PulseFalso();
  configurar?.(pulse);
  const url = await pulse.iniciar();
  const linhas = [];
  const d = criarDistribuidor({
    banco: sql,
    env: { PULSE_API_URL: `${url}/core`, PULSE_API_TOKEN: pulse.token, DISTRIBUICAO_ORCAMENTO_5MIN: '950', ...env },
    intervaloMinMs: 0,
    saidaLog: (l) => linhas.push(JSON.parse(l)),
    agora,
    dormir,
    relogioLimitador,
  });
  const config = async (c) => d.estado.gravarEstado({ config: { ligado: false, teto: 15, maxPorCiclo: 10, alertaFilaMin: 30, equipes: {}, ...c } });
  return {
    sql, pulse, d, linhas, url, config,
    tipos: () => linhas.map((l) => l.tipo),
    decisoes: async () => d.estado.ultimasDecisoes(1000),
    fechar: () => pulse.parar(),
  };
}
