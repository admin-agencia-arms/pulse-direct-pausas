// Peças puras da distribuição: datas, regra de alocação, detector de mudanças e cliente do Pulse Direct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inicioDoDia, isoMicros, lerData, lerMicros } from '../src/distribuicao/datas.js';
import { alocar } from '../src/distribuicao/alocador.js';
import { mudancasAtendentes, mudancasEquipes } from '../src/distribuicao/mudancas.js';
import { AtribuicaoBloqueada, ClientePulse, ErroPulse, Limitador, enderecosPulse } from '../src/distribuicao/pulse.js';

// ---------- datas ----------

test('datas: formatos do Pulse Direct (com e sem Z, 6 a 8 casas)', () => {
  const esperado = Date.UTC(2026, 8, 26, 11, 48, 0, 997);
  assert.equal(lerData('2026-09-26T11:48:00.99776200'), esperado);
  assert.equal(lerData('2026-09-26T11:48:00.9977620Z'), esperado);
  assert.equal(lerData('2026-09-26T08:48:00-03:00'), Date.UTC(2026, 8, 26, 11, 48, 0));
  assert.equal(lerData(null), null);
  assert.equal(lerData('lixo'), null);
  const base = Date.UTC(2026, 9, 7, 23, 37, 27, 151) * 1000;
  assert.equal(lerMicros('2026-10-07T23:37:27.151707Z'), base + 707);
  assert.equal(lerMicros('2026-10-07T23:37:27.15170700'), base + 707);
  assert.equal(isoMicros(base + 706), '2026-10-07T23:37:27.151706Z');
  assert.equal(inicioDoDia(Date.UTC(2026, 9, 7, 1, 30)), Date.UTC(2026, 9, 6, 3, 0)); // 22:30 do dia 06 em São Paulo
});

// ---------- alocador ----------

const at = (userId, equipes, online = true) => ({ userId, nome: userId, online, equipes: new Set(equipes) });
const entrada = (p) => ({ fila: [], atendentes: [], carga: new Map(), ultimaEntrega: new Map(), equipesGerenciadas: new Set(['A', 'B']), teto: 15, maxPorAtendente: 50, maxTotal: 1000, ...p });
const filaDe = (n, equipeId = 'A') => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, equipeId, criadaEm: i }));

test('alocador: completa até o teto (14 → recebe 1, 10 → recebe 5) e nunca passa', () => {
  const r = alocar(entrada({ fila: filaDe(20), atendentes: [at('ana', ['A']), at('bia', ['A'])], carga: new Map([['ana', 14], ['bia', 10]]) }));
  assert.equal(r.decisoes.filter((d) => d.userId === 'ana').length, 1);
  assert.equal(r.decisoes.filter((d) => d.userId === 'bia').length, 5);
  assert.equal(r.semVaga.get('A'), 14);
});

test('alocador: mais antiga primeiro, para o menos carregado; só da equipe e online', () => {
  const r = alocar(entrada({
    fila: [{ id: 'nova', equipeId: 'A', criadaEm: 200 }, { id: 'velha', equipeId: 'A', criadaEm: 100 }, { id: 'b1', equipeId: 'B', criadaEm: 1 }],
    atendentes: [at('ana', ['A']), at('bia', ['A']), at('caio', ['B'], false)],
    carga: new Map([['ana', 3], ['bia', 1]]), maxTotal: 2,
  }));
  assert.deepEqual(r.decisoes.map((d) => [d.conversaId, d.userId]), [['velha', 'bia'], ['nova', 'bia']]);
  assert.equal(r.semVaga.get('B'), 1);
});

test('alocador: teto único para quem está em duas equipes; equipe fora do sistema é ignorada', () => {
  const r = alocar(entrada({
    fila: [{ id: 'a1', equipeId: 'A', criadaEm: 1 }, { id: 'b1', equipeId: 'B', criadaEm: 2 }, { id: 'ia', equipeId: 'IA', criadaEm: 0 }],
    atendentes: [at('caio', ['A', 'B', 'IA'])], carga: new Map([['caio', 14]]),
  }));
  assert.deepEqual(r.decisoes.map((d) => d.conversaId), ['a1']);
});

test('alocador: empate vai para quem recebeu há mais tempo; limite por ciclo e pares bloqueados', () => {
  assert.equal(alocar(entrada({ fila: filaDe(1), atendentes: [at('ana', ['A']), at('bia', ['A'])], ultimaEntrega: new Map([['ana', 500], ['bia', 100]]) })).decisoes[0].userId, 'bia');
  assert.equal(alocar(entrada({ fila: filaDe(30), atendentes: [at('ana', ['A']), at('bia', ['A'])], maxPorAtendente: 3 })).decisoes.length, 6);
  const r = alocar(entrada({ fila: filaDe(1), atendentes: [at('ana', ['A']), at('bia', ['A'])], bloqueado: (c, u) => u === 'ana' }));
  assert.equal(r.decisoes[0].userId, 'bia');
});

// ---------- mudanças ----------

test('mudanças: equipes e atendentes (novo, removido, renomeado, online/offline, entrou/saiu)', () => {
  const eq = mudancasEquipes(
    [{ id: 'A', nome: 'Exames', distribuicaoNativa: false }, { id: 'B', nome: 'Cirurgia', distribuicaoNativa: true }],
    [{ id: 'A', nome: 'Exames e Laudos', distribuicaoNativa: true }, { id: 'C', nome: 'Geral', distribuicaoNativa: false }]);
  assert.deepEqual(eq.map((m) => m.tipo).sort(), ['equipe_criada', 'equipe_distribuicao_nativa', 'equipe_removida', 'equipe_renomeada']);
  const nomes = { A: 'Exames', B: 'Cirurgia' };
  const ate = (userId, nome, disponivel, equipes) => ({ userId, nome, disponivel, equipes });
  const msgs = mudancasAtendentes(
    [ate('1', 'Ana', false, ['A']), ate('2', 'Bia', true, ['A', 'B']), ate('3', 'Caio', true, [])],
    [ate('1', 'Ana Souza', true, ['A', 'B']), ate('2', 'Bia', false, ['B']), ate('4', 'Dani', true, ['A'])],
    (id) => nomes[id] ?? id, { disponibilidade: true }).map((m) => m.mensagem);
  for (const m of ['Ana agora se chama Ana Souza', 'Ana Souza ficou online', 'Ana Souza passou a atender Cirurgia', 'Bia ficou offline',
    'Bia deixou de atender Exames', 'Novo usuário no Pulse Direct: Dani (atende Exames)', 'Usuário removido do Pulse Direct: Caio']) {
    assert.ok(msgs.includes(m), m);
  }
});

// ---------- cliente do Pulse Direct ----------

function fetchEmSequencia(respostas) {
  const pedidos = [];
  const f = async (url, init) => {
    pedidos.push({ url, metodo: init?.method, corpo: init?.body });
    const r = respostas.shift();
    if (!r) throw new Error('sem resposta preparada');
    if (r instanceof Error) throw r;
    return r;
  };
  return { f, pedidos };
}
const ok = (corpo, headers) => new Response(JSON.stringify(corpo), { status: 200, headers });
const cliente = (f, extra = {}) => {
  let deslocamento = 0; // relógio simulado: a pausa de um 429 não espera de verdade
  return new ClientePulse({
    token: 't', core: 'https://pulse.exemplo/core', chat: 'https://pulse.exemplo/chat',
    limitador: new Limitador(1000, 0, () => Date.now() + deslocamento, async (ms) => { deslocamento += ms; }), fetch: f, ...extra,
  });
};

test('pulse: endereços — "chat" derivado de PULSE_API_URL (…/core) ou explícito', () => {
  assert.deepEqual(enderecosPulse({ PULSE_API_URL: 'https://x/core/' }), { core: 'https://x/core', chat: 'https://x/chat' });
  assert.deepEqual(enderecosPulse({ PULSE_API_URL: 'https://x/api', PULSE_CHAT_API_URL: 'https://y/chat' }), { core: 'https://x/api', chat: 'https://y/chat' });
});

test('pulse: atribuir com a distribuição desligada não chega na rede', async () => {
  const { f, pedidos } = fetchEmSequencia([ok({})]);
  await assert.rejects(cliente(f).atribuir('c', 'u'), AtribuicaoBloqueada);
  assert.equal(pedidos.length, 0);
});

test('pulse: escrita nunca é repetida (429 / queda de rede viram erro passageiro na hora)', async () => {
  const limite = fetchEmSequencia([new Response('', { status: 429 }), ok({})]);
  await assert.rejects(cliente(limite.f, { permitirAtribuir: true }).atribuir('c', 'u'), (e) => e instanceof ErroPulse && e.status === 429 && e.passageira);
  assert.equal(limite.pedidos.length, 1);
  const rede = fetchEmSequencia([new Error('ETIMEDOUT')]);
  await assert.rejects(cliente(rede.f, { permitirAtribuir: true }).atribuir('c', 'u'), (e) => e.status === 0 && /resultado incerto/.test(e.message));
  assert.equal(rede.pedidos.length, 1);
});

test('pulse: leitura tenta de novo em 429/5xx e para em 401', async () => {
  const l = fetchEmSequencia([new Response('', { status: 429 }), new Response('', { status: 502 }), ok([])]);
  assert.deepEqual(await cliente(l.f).listarEquipes(), []);
  assert.equal(l.pedidos.length, 3);
  const n = fetchEmSequencia([new Response('{}', { status: 401 })]);
  await assert.rejects(cliente(n.f).listarAtendentes(), /recusou o token/);
});

test('pulse: página de erro que não é JSON nunca vai para a mensagem (nem o endereço de quem respondeu)', async () => {
  const pagina = '<html><title>api.provedor.exemplo | 502: Bad gateway</title></html>';
  const escrita = fetchEmSequencia([new Response(pagina, { status: 502 })]);
  await assert.rejects(cliente(escrita.f).configurarEquipe('d1', { nome: 'X' }), (e) => e.status === 502 && !/provedor|html/i.test(e.message));
  const leitura = fetchEmSequencia([new Response(pagina, { status: 200 })]);
  await assert.rejects(cliente(leitura.f).listarEquipes(), (e) => e.status === 502 && !/provedor|html/i.test(e.message));
});

test('pulse: paginação por data em µs, sem pular nada mesmo com empate de 250 no mesmo instante', async () => {
  const instante = '2026-10-07T12:00:00.123456Z';
  const empate = (de, n, depois = 0) => ok({ items: [
    ...Array.from({ length: n }, (_, i) => ({ id: `e${de + i}`, status: 'PENDING', updatedAt: instante })),
    ...Array.from({ length: depois }, (_, i) => ({ id: `d${i}`, status: 'PENDING', updatedAt: '2026-10-07T12:00:05.000000Z' })),
  ] });
  const { f, pedidos } = fetchEmSequencia([empate(0, 100), empate(0, 100), empate(100, 100), empate(200, 50, 30)]);
  const lote = await cliente(f).listarAtualizadas([], Date.UTC(2026, 9, 7), 10);
  assert.equal(lote.conversas.length, 280);
  assert.equal(lote.completo, true);
  assert.deepEqual(pedidos.map((p) => { const u = new URL(p.url); return [u.searchParams.get('UpdatedAt.After'), u.searchParams.get('PageNumber')]; }), [
    ['2026-10-07T00:00:00.000000Z', null], ['2026-10-07T12:00:00.123455Z', null], ['2026-10-07T12:00:00.123455Z', '2'], ['2026-10-07T12:00:00.123455Z', '3'],
  ]);
});

test('pulse: contagem esquisita nunca vira zero', async () => {
  for (const ruim of [{}, { totalItems: null }, { totalItems: 'quinze' }, { totalItems: -1 }]) {
    const { f } = fetchEmSequencia([ok(ruim)]);
    await assert.rejects(cliente(f).contarAbertas('ana'), /Contagem inválida/);
  }
});

test('pulse: gestão de equipe e assinatura de eventos mandam o corpo certo', async () => {
  const { f, pedidos } = fetchEmSequencia([ok({}), ok({}), ok({}), ok([]), ok({ id: 's1' })]);
  const c = cliente(f);
  await c.incluirNaEquipe('A', 'ana');
  await c.removerDaEquipe('B', 'ana');
  await c.configurarEquipe('A', { nome: 'Exames 2', distribuicaoNativa: false });
  await c.listarAssinaturas();
  await c.criarAssinatura('Distribuição', 'https://app/api/distribuicao/evento?token=x');
  assert.deepEqual(pedidos.map((p) => [p.metodo, p.url.replace('https://pulse.exemplo', '')]), [
    ['PUT', '/core/v1/department/A/agents'], ['PUT', '/core/v1/department/B/agents'], ['PUT', '/core/v1/department/A'],
    ['GET', '/core/v1/webhook/subscription'], ['POST', '/core/v1/webhook/subscription'],
  ]);
  assert.deepEqual(JSON.parse(pedidos[0].corpo), { action: 'Upsert', items: [{ userId: 'ana', isAgent: true, isSupervisor: false }] });
  assert.deepEqual(JSON.parse(pedidos[1].corpo).action, 'Remove');
  assert.deepEqual(JSON.parse(pedidos[2].corpo), { fields: ['Name', 'DistributionIsEnabled'], name: 'Exames 2', distributionIsEnabled: false });
  assert.deepEqual(JSON.parse(pedidos[4].corpo).events, ['SESSION_NEW', 'SESSION_UPDATE', 'SESSION_COMPLETE']);
});

test('pulse: relógio do Pulse Direct vem do cabeçalho Date; só guarda campos de controle', async () => {
  const { f } = fetchEmSequencia([ok({ items: [{ id: 'c1', status: 'PENDING', lastMessageText: 'exame', contactDetails: { name: 'Fulano' } }] }, { Date: 'Thu, 08 Oct 2026 00:28:02 GMT' })]);
  const c = cliente(f);
  const [conv] = (await c.listarAtualizadas([], 0, 1)).conversas;
  assert.ok(!JSON.stringify(conv).includes('exame') && !JSON.stringify(conv).includes('Fulano'));
  assert.ok(Math.abs(c.relogioPulse() - Date.parse('2026-10-08T00:28:02Z')) < 1000);
});

test('limitador: orçamento de 5 min, intervalo mínimo, pausa e chamadas de outras execuções', async () => {
  let t = 1_000_000;
  const lim = new Limitador(3, 250, () => t, async (ms) => { t += ms; });
  lim.semear([t - 400_000, t - 100_000]); // a primeira já saiu da janela
  assert.equal(lim.uso(), 1);
  await lim.aguardarVez();
  await lim.aguardarVez();
  assert.equal(lim.livre(), false);
  const antes = t;
  await lim.aguardarVez(); // espera a janela abrir
  assert.equal(t, antes + 199_750); // a chamada mais antiga (há 100 s) sai da janela de 5 min
});
