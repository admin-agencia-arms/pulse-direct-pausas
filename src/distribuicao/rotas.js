// Rotas da distribuição automática (aba /distribuicao, só para administradores).
import crypto from 'node:crypto';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { sql, audit } from '../db.js';
import { criarEstado } from './estado.js';
import { Registro } from './registro.js';
import { Distribuidor } from './motor.js';
import { ClientePulse, ErroPulse, Limitador, enderecosPulse } from './pulse.js';

const ORCAMENTO_5MIN = Number(process.env.DISTRIBUICAO_ORCAMENTO_5MIN || 250);
/** Painel aberto: se o último ciclo for mais velho que isso, roda um antes de responder. */
const PAINEL_ATUALIZA_MS = 20_000;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const igual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const nomeAtor = (u) => u?.name || u?.email || 'Administrador';
/** Erro vindo do Pulse Direct vira mensagem legível para o administrador (e não "erro interno"). */
const legivel = (e) => (e instanceof ErroPulse ? Object.assign(new Error(`Pulse Direct: ${e.message}`), { status: 502 }) : e);

let instancia = null;
let preparo = null;

/** Monta o distribuidor com as dependências de produção (ou as de teste, se passadas). */
export function criarDistribuidor({ banco = sql, fetch: f, env = process.env, saidaLog, agora, intervaloMinMs = 250, relogioLimitador, dormir } = {}) {
  const estado = criarEstado(banco);
  const log = new Registro(estado, { saida: saidaLog, agora });
  const criarPulse = ({ permitirAtribuir, aoChamar, aoLimite, instantes }) => {
    const { core, chat } = enderecosPulse(env);
    const limitador = new Limitador(Number(env.DISTRIBUICAO_ORCAMENTO_5MIN || ORCAMENTO_5MIN), intervaloMinMs, relogioLimitador, dormir);
    limitador.semear(instantes);
    return new ClientePulse({ token: env.PULSE_API_TOKEN || '', core, chat, limitador, permitirAtribuir, fetch: f, aoChamar, aoLimite });
  };
  return new Distribuidor({ estado, criarPulse, log, agora, dormir, orcamento5min: Number(env.DISTRIBUICAO_ORCAMENTO_5MIN || ORCAMENTO_5MIN) });
}

export function usarDistribuidor(d) {
  instancia = d;
  preparo = null;
}

function distribuidor() {
  instancia ??= criarDistribuidor();
  return instancia;
}

/** Garante as tabelas (cria se o usuário do banco puder; senão o painel explica o que rodar). */
async function pronto() {
  preparo ??= distribuidor().estado.preparar().then((r) => {
    if (!r.ok) preparo = null;
    return r;
  }, (e) => {
    preparo = null; // banco fora do ar: tenta de novo na próxima chamada
    throw e;
  });
  return preparo;
}

/**
 * Trabalho depois da resposta: o webhook do Pulse Direct recebe 202 na hora (remetentes de webhook
 * costumam desistir em poucos segundos) e a Vercel mantém a função viva até o ciclo terminar.
 */
const emSegundoPlano = new Set();
function depoisDaResposta(promessa) {
  const p = promessa
    .catch((e) => console.error(JSON.stringify({ origem: 'distribuicao', nivel: 'erro', tipo: 'segundo_plano', mensagem: e?.message ?? String(e) })))
    .finally(() => emSegundoPlano.delete(p));
  emSegundoPlano.add(p);
  waitUntil(p);
}

/** Para testes: espera o que ficou rodando depois da resposta. */
export const aguardarSegundoPlano = () => Promise.allSettled([...emSegundoPlano]);

// ---------------- públicas (protegidas por segredo) ----------------

export const rotasPublicas = express.Router();

// Eventos de conversa do Pulse Direct (webhook). O conteúdo nunca é usado: o evento só antecipa um ciclo.
rotasPublicas.post('/evento', (req, res) => {
  const segredo = process.env.DISTRIBUICAO_SEGREDO || '';
  if (!segredo || !igual(req.query.token ?? '', segredo)) return res.status(401).json({ error: 'Não autorizado.' });
  depoisDaResposta(pronto().then((p) => (p.ok ? distribuidor().aoEvento() : null)));
  res.status(202).json({ ok: true });
});

// Agendador (Vercel Cron, pg_cron ou monitor externo): Authorization: Bearer CRON_SECRET.
const agendador = wrap(async (req, res) => {
  const segredo = process.env.CRON_SECRET || '';
  const dado = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!segredo || !igual(dado, segredo)) return res.status(401).json({ error: 'Não autorizado.' });
  const p = await pronto();
  if (!p.ok) return res.status(503).json({ error: p.erro });
  res.json(await distribuidor().aoAgendador());
});
rotasPublicas.get('/ciclo', agendador);
rotasPublicas.post('/ciclo', agendador);

/** Depois de uma mudança do admin, roda um ciclo para a tela já refletir (esperando o que estiver em andamento). */
async function cicloAposMudanca(d) {
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    const r = await d.ciclo({ origem: 'manual', prazoMs: 15_000 }).catch(() => ({ executado: false }));
    if (r.executado || r.motivo !== 'em_andamento') return r;
    await new Promise((ok) => setTimeout(ok, 1_500));
  }
  return { executado: false };
}

// ---------------- administração ----------------

export const rotasAdmin = express.Router();

rotasAdmin.use(wrap(async (req, res, next) => {
  const p = await pronto();
  if (!p.ok) return res.status(503).json({ error: p.erro, naoPreparado: true });
  next();
}));

rotasAdmin.get('/', wrap(async (req, res) => {
  const d = distribuidor();
  const { ciclo } = await d.estado.lerEstado(['ciclo']);
  if (!ciclo?.ultimoInicio || Date.now() - ciclo.ultimoInicio > PAINEL_ATUALIZA_MS) {
    await d.ciclo({ origem: 'painel', prazoMs: 20_000 });
  }
  res.json({ ...(await d.painel()), eventosConfiguravel: Boolean(process.env.DISTRIBUICAO_SEGREDO) });
}));

rotasAdmin.post('/atualizar', wrap(async (req, res) => {
  res.json(await cicloAposMudanca(distribuidor()));
}));

const CATEGORIA = (tipo) => (tipo.startsWith('atendente') || tipo.startsWith('equipe') || tipo.startsWith('gestao') ? 'pessoas'
  : tipo.startsWith('decisao') ? 'decisoes' : 'sistema');

function decisaoComoItem(d) {
  const conversa = String(d.conversaId).slice(0, 8);
  const textos = {
    simulado: `Simulação: mandaria a conversa ${conversa} de ${d.equipe} para ${d.atendente} (tinha ${d.cargaAntes}).`,
    atribuido: `Conversa ${conversa} de ${d.equipe} entregue a ${d.atendente} (tinha ${d.cargaAntes}).`,
    ignorado: `Conversa ${conversa} de ${d.equipe} não foi entregue a ${d.atendente}: ${d.detalhe ?? ''}`,
    erro: `Falha ao entregar a conversa ${conversa} de ${d.equipe} a ${d.atendente}: ${d.detalhe ?? ''}`,
    desfecho: `Conversa ${conversa} de ${d.equipe}: ${d.detalhe ?? ''}`,
  };
  return {
    em: Number(d.em), nivel: d.resultado === 'erro' ? 'erro' : d.resultado === 'ignorado' ? 'aviso' : 'info',
    tipo: `decisao_${d.resultado}`, categoria: 'decisoes', mensagem: textos[d.resultado] ?? `${d.resultado}: ${conversa}`,
  };
}

rotasAdmin.get('/registro', wrap(async (req, res) => {
  const limite = Math.min(1000, Math.max(1, Number(req.query.limite) || 300));
  const filtro = String(req.query.categoria || '');
  const { estado } = distribuidor();
  const eventos = (await estado.ultimosEventos(limite)).map((e) => ({ em: Number(e.em), nivel: e.nivel, tipo: e.tipo, categoria: CATEGORIA(e.tipo), mensagem: e.mensagem }));
  const decisoes = (await estado.ultimasDecisoes(limite)).map(decisaoComoItem);
  let itens = [...eventos, ...decisoes].sort((a, b) => b.em - a.em);
  if (filtro === 'erros') itens = itens.filter((i) => i.nivel !== 'info');
  else if (filtro) itens = itens.filter((i) => i.categoria === filtro);
  res.json(itens.slice(0, limite));
}));

const csvCelula = (v) => {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${s.replace(/^([=+\-@\t])/, "'$1").replace(/"/g, '""')}"` : s;
};

rotasAdmin.get('/atendentes.csv', wrap(async (req, res) => {
  const p = await distribuidor().painel();
  const linhas = [['Atendente', 'E-mail', 'Equipes', 'Online', 'Abertos', 'Abertos por equipe', 'Pendentes', 'Em atendimento', 'Vagas', 'Concluídos hoje']];
  for (const a of [...p.atendentes].sort((x, y) => y.abertas - x.abertas || x.nome.localeCompare(y.nome))) {
    linhas.push([a.nome, a.email ?? '', a.equipes.map((e) => e.nome).join(', '), a.online ? 'Sim' : 'Não', a.abertas,
      a.porEquipe.map((e) => `${e.nome}: ${e.n}`).join(' | '), a.pendentes, a.emAtendimento, a.vagas, a.concluidasHoje]);
  }
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="distribuicao_atendentes_${hoje}.csv"`);
  res.send('﻿' + linhas.map((l) => l.map(csvCelula).join(';')).join('\r\n'));
}));

rotasAdmin.post('/ligar', wrap(async (req, res) => {
  if (typeof req.body?.ligado !== 'boolean') return res.status(400).json({ error: 'Informe ligado: true ou false.' });
  const config = await distribuidor().ligar(req.body.ligado, nomeAtor(req.user));
  await audit(req.user.id, null, 'distribuicao_ligar', { ligado: config.ligado });
  res.json({ ok: true, ligado: config.ligado });
}));

rotasAdmin.put('/config', wrap(async (req, res) => {
  const { teto, maxPorCiclo, alertaFilaMin } = req.body ?? {};
  const config = await distribuidor().salvarConfig({ teto, maxPorCiclo, alertaFilaMin }, nomeAtor(req.user));
  await audit(req.user.id, null, 'distribuicao_config', { teto: config.teto, maxPorCiclo: config.maxPorCiclo, alertaFilaMin: config.alertaFilaMin });
  res.json({ ok: true });
}));

rotasAdmin.put('/equipes/:id', wrap(async (req, res) => {
  const { nome, distribuicaoNativa, incluir } = req.body ?? {};
  const d = distribuidor();
  const mudancas = await d.configurarEquipe(req.params.id, { nome, distribuicaoNativa, incluir }, nomeAtor(req.user)).catch((e) => { throw legivel(e); });
  await audit(req.user.id, null, 'distribuicao_equipe', { equipeId: req.params.id, ...mudancas, incluir });
  await cicloAposMudanca(d);
  res.json({ ok: true });
}));

rotasAdmin.put('/atendentes/:userId/equipes', wrap(async (req, res) => {
  const lista = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const adicionar = lista(req.body?.adicionar);
  const remover = lista(req.body?.remover);
  if (!adicionar.length && !remover.length) return res.status(400).json({ error: 'Nada para mudar.' });
  const d = distribuidor();
  const r = await d.mudarEquipesDoAtendente(req.params.userId, { adicionar, remover }, nomeAtor(req.user)).catch((e) => { throw legivel(e); });
  await audit(req.user.id, null, 'distribuicao_equipes_atendente', { userId: req.params.userId, adicionar, remover, falhas: r.falhas });
  await cicloAposMudanca(d);
  if (r.falhas.length && !r.feitas.length) return res.status(502).json({ error: `Não deu para mudar as equipes: ${r.falhas.join('; ')}` });
  res.json({ ok: true, ...r });
}));

rotasAdmin.put('/equipes/:id/membros', wrap(async (req, res) => {
  const lista = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);
  const adicionar = lista(req.body?.adicionar);
  const remover = lista(req.body?.remover);
  if (!adicionar.length && !remover.length) return res.status(400).json({ error: 'Nada para mudar.' });
  if (adicionar.length + remover.length > 100) return res.status(400).json({ error: 'No máximo 100 pessoas por vez.' });
  const d = distribuidor();
  const r = await d.mudarMembrosDaEquipe(req.params.id, { adicionar, remover }, nomeAtor(req.user)).catch((e) => { throw legivel(e); });
  await audit(req.user.id, null, 'distribuicao_membros_equipe', { equipeId: req.params.id, adicionar, remover, falhas: r.falhas });
  await cicloAposMudanca(d);
  if (r.falhas.length && !r.feitas) return res.status(502).json({ error: `Não deu para mudar os membros: ${r.falhas.join('; ')}` });
  res.json({ ok: true, ...r });
}));

rotasAdmin.post('/eventos', wrap(async (req, res) => {
  const segredo = process.env.DISTRIBUICAO_SEGREDO || '';
  if (!segredo) return res.status(400).json({ error: 'Defina DISTRIBUICAO_SEGREDO na configuração do servidor antes de ligar os eventos.' });
  const origem = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const url = `${origem}/api/distribuicao/evento?token=${encodeURIComponent(segredo)}`;
  const r = await distribuidor().configurarEventos(url, nomeAtor(req.user)).catch((e) => { throw legivel(e); });
  await audit(req.user.id, null, 'distribuicao_eventos', { criada: r.criada });
  res.json({ ok: true, ...r });
}));
