// Ponta a ponta pelo app (Express real, login real, banco local, Pulse Direct falso).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { TEM_BANCO, encerrar, limpar, preparar } from './apoio.js';
import { PulseFalso } from './pulse-falso.js';

const caso = TEM_BANCO ? test : test.skip;
const ADMIN = 'admin.distribuicao@teste.com';
const USUARIO = 'usuario.comum@teste.com';
let base = null;
let servidor = null;
let pulse = null;
let sql = null;

async function entrar(email) {
  await fetch(`${base}/api/auth/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const r = await fetch(`${base}/api/auth/first-access`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'senha12345', confirm: 'senha12345' }),
  });
  assert.equal(r.status, 200, `primeiro acesso de ${email}`);
  return r.headers.get('set-cookie').split(';')[0];
}

const chamar = (cookie, caminho, { method = 'GET', body } = {}) => fetch(`${base}/api${caminho}`, {
  method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
});

before(async () => {
  if (!TEM_BANCO) return;
  pulse = new PulseFalso();
  pulse.equipe('A', 'Exames');
  pulse.equipe('B', 'Cirurgia');
  pulse.agente('ana', ['A'], true, 'ANA SOUZA');
  pulse.agente('bia', ['A'], true, '=HYPERLINK("http://mal.exemplo")');
  for (let i = 0; i < 5; i++) pulse.novaConversa({ departmentId: 'A', userId: 'ana', status: 'IN_PROGRESS' });
  for (let i = 0; i < 3; i++) pulse.novaConversa({ departmentId: 'A' });
  const url = await pulse.iniciar();
  Object.assign(process.env, {
    PULSE_API_URL: `${url}/core`, PULSE_API_TOKEN: pulse.token, ADMIN_EMAILS: ADMIN,
    CRON_SECRET: 'segredo-do-agendador', DISTRIBUICAO_SEGREDO: 'segredo-dos-eventos',
  });
  ({ sql } = await preparar());
  await limpar(sql);
  await sql`DELETE FROM sessions`;
  await sql`DELETE FROM audit`;
  await sql`DELETE FROM users WHERE email IN (${ADMIN}, ${USUARIO})`;
  await sql`INSERT INTO users (email, name, role, created_at, updated_at) VALUES (${USUARIO}, 'Usuário Comum', 'user', ${Date.now()}, ${Date.now()})`;
  const { app } = await import('../src/http.js');
  await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  servidor?.closeAllConnections?.();
  await new Promise((r) => (servidor ? servidor.close(r) : r()));
  await pulse?.parar();
  await encerrar();
});

caso('só administrador acessa: sem login 401, usuário comum 403', async () => {
  assert.equal((await fetch(`${base}/api/admin/distribuicao`)).status, 401);
  const cookie = await entrar(USUARIO);
  assert.equal((await chamar(cookie, '/admin/distribuicao')).status, 403);
  assert.equal((await chamar(cookie, '/admin/distribuicao/ligar', { method: 'POST', body: { ligado: true } })).status, 403);
  assert.equal((await chamar(cookie, '/admin/distribuicao/equipes/A/membros', { method: 'PUT', body: { adicionar: ['bia'] } })).status, 403);
});

caso('painel do admin: lê o Pulse Direct, mostra abertos por equipe e começa DESLIGADO', async () => {
  const cookie = await entrar(ADMIN);
  const r = await chamar(cookie, '/admin/distribuicao');
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(p.ligado, false, 'sobe com a distribuição desligada');
  const ana = p.atendentes.find((a) => a.userId === 'ana');
  assert.deepEqual(ana.porEquipe, [{ id: 'A', nome: 'Exames', n: 5, membro: true }]);
  assert.equal(p.equipes.find((e) => e.id === 'A').aguardando, 3);
  assert.equal(pulse.puts.length, 0);
});

caso('ações do admin: incluir equipe, mudar equipes de alguém, ligar/desligar, configurações (com auditoria)', async () => {
  const cookie = await entrar(ADMIN).catch(async () => {
    // já tem senha do teste anterior: faz login
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN, password: 'senha12345' }) });
    return r.headers.get('set-cookie').split(';')[0];
  });
  let r = await chamar(cookie, '/admin/distribuicao/equipes/A', { method: 'PUT', body: { incluir: true } });
  assert.equal(r.status, 200);
  r = await chamar(cookie, '/admin/distribuicao/atendentes/bia/equipes', { method: 'PUT', body: { adicionar: ['B'], remover: [] } });
  assert.equal(r.status, 200);
  assert.deepEqual(pulse.agentes.get('bia').equipes, ['A', 'B']);
  r = await chamar(cookie, '/admin/distribuicao/atendentes/bia/equipes', { method: 'PUT', body: {} });
  assert.equal(r.status, 400);
  r = await chamar(cookie, '/admin/distribuicao/config', { method: 'PUT', body: { teto: 999 } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Teto por atendente/);
  r = await chamar(cookie, '/admin/distribuicao/ligar', { method: 'POST', body: { ligado: true } });
  assert.equal((await r.json()).ligado, true);
  r = await chamar(cookie, '/admin/distribuicao/ligar', { method: 'POST', body: { ligado: false } });
  assert.equal((await r.json()).ligado, false);
  const acoes = (await sql`SELECT action FROM audit WHERE action LIKE 'distribuicao%' ORDER BY id`).map((a) => a.action);
  assert.deepEqual(acoes, ['distribuicao_equipe', 'distribuicao_equipes_atendente', 'distribuicao_ligar', 'distribuicao_ligar']);
  const reg = await (await chamar(cookie, '/admin/distribuicao/registro?categoria=pessoas')).json();
  assert.ok(reg.some((i) => /colocou .* em Cirurgia/.test(i.mensagem)));
});

caso('membros da equipe: colocar e tirar várias pessoas de uma vez (com auditoria)', async () => {
  const r0 = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN, password: 'senha12345' }) });
  const cookie = r0.headers.get('set-cookie').split(';')[0];
  const antes = (await chamar(cookie, '/admin/distribuicao').then((r) => r.json()));
  assert.ok(antes.usuarios.some((u) => u.userId === 'ana'), 'painel traz todos os usuários');
  let r = await chamar(cookie, '/admin/distribuicao/equipes/B/membros', { method: 'PUT', body: { adicionar: ['ana', 'bia'], remover: [] } });
  assert.equal(r.status, 200);
  assert.ok(pulse.agentes.get('ana').equipes.includes('B') && pulse.agentes.get('bia').equipes.includes('B'));
  r = await chamar(cookie, '/admin/distribuicao/equipes/B/membros', { method: 'PUT', body: { remover: ['ana'] } });
  assert.equal(r.status, 200);
  assert.ok(!pulse.agentes.get('ana').equipes.includes('B'));
  r = await chamar(cookie, '/admin/distribuicao/equipes/B/membros', { method: 'PUT', body: {} });
  assert.equal(r.status, 400);
  r = await chamar(cookie, '/admin/distribuicao/equipes/B/membros', { method: 'PUT', body: { adicionar: ['ninguem'] } });
  assert.equal(r.status, 400);
  const n = await sql`SELECT count(*)::int AS n FROM audit WHERE action = 'distribuicao_membros_equipe'`;
  assert.equal(n[0].n, 2);
});

caso('planilha: BOM, ponto e vírgula e nome com fórmula neutralizado', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN, password: 'senha12345' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await (await chamar(cookie, '/admin/distribuicao/atendentes.csv')).arrayBuffer());
  assert.ok(csv.startsWith('﻿Atendente;E-mail;Equipes;Online;Abertos;Abertos por equipe;'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://mal.exemplo"")"`));
  assert.ok(!/(^|;)=HYPERLINK/m.test(csv));
});

caso('rotas públicas exigem segredo: eventos (token) e agendador (Bearer)', async () => {
  assert.equal((await fetch(`${base}/api/distribuicao/evento`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/distribuicao/evento?token=errado`, { method: 'POST' })).status, 401);
  const t0 = Date.now();
  const ev = await fetch(`${base}/api/distribuicao/evento?token=segredo-dos-eventos`, { method: 'POST', body: '{}' });
  assert.equal(ev.status, 202);
  assert.ok(Date.now() - t0 < 1_000, 'responde na hora; o ciclo roda depois da resposta');
  assert.equal((await fetch(`${base}/api/distribuicao/ciclo`)).status, 401);
  const ag = await fetch(`${base}/api/distribuicao/ciclo`, { headers: { Authorization: 'Bearer segredo-do-agendador' } });
  assert.equal(ag.status, 200);
});

caso('ligar os eventos cria a assinatura no Pulse Direct (uma vez só)', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN, password: 'senha12345' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const a = await (await chamar(cookie, '/admin/distribuicao/eventos', { method: 'POST' })).json();
  const b = await (await chamar(cookie, '/admin/distribuicao/eventos', { method: 'POST' })).json();
  assert.deepEqual([a.criada, b.criada], [true, false]);
  assert.equal(pulse.assinaturas.length, 1);
  assert.match(pulse.assinaturas[0].url, /\/api\/distribuicao\/evento\?token=segredo-dos-eventos$/);
  assert.deepEqual(pulse.assinaturas[0].events.map((e) => e.event), ['SESSION_NEW', 'SESSION_UPDATE', 'SESSION_COMPLETE']);
});
