// Motor da distribuição contra Postgres local + Pulse Direct falso por HTTP (nada toca a produção).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { TEM_BANCO, cenario, encerrar } from './apoio.js';
import { TEXTO_SENSIVEL } from './pulse-falso.js';

const caso = TEM_BANCO ? test : test.skip;
after(encerrar);

/** Exames com Ana (14 abertas) e Bia (10), Caio offline; 8 na fila de Exames e 3 na do chatbot. */
function base(p) {
  p.equipe('A', 'Exames');
  p.equipe('B', 'Cirurgia');
  p.equipe('BOT', 'Chatbot');
  p.agente('ana', ['A'], true, 'Ana');
  p.agente('bia', ['A'], true, 'Bia');
  p.agente('caio', ['A'], false, 'Caio');
  for (let i = 0; i < 14; i++) p.novaConversa({ departmentId: 'A', userId: 'ana', status: 'IN_PROGRESS' });
  for (let i = 0; i < 10; i++) p.novaConversa({ departmentId: 'A', userId: 'bia', status: i < 4 ? 'PENDING' : 'IN_PROGRESS' });
  for (let i = 0; i < 8; i++) p.novaConversa({ departmentId: 'A' });
  for (let i = 0; i < 3; i++) p.novaConversa({ departmentId: 'BOT' });
}
const filaDe = (p, equipe) => [...p.conversas.values()].filter((c) => c.departmentId === equipe && c.status === 'PENDING' && !c.userId);

// ---------- simulação ----------

caso('simulação: decide, registra, não escreve, não repete e registra o desfecho real', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.config({ equipes: { A: true } });
    await c.d.ciclo({ origem: 'manual' });
    let simuladas = (await c.decisoes()).filter((d) => d.resultado === 'simulado');
    assert.equal(simuladas.filter((d) => d.userId === 'ana').length, 1);
    assert.equal(simuladas.filter((d) => d.userId === 'bia').length, 5);
    assert.equal(c.pulse.puts.length, 0, 'simulação nunca escreve no Pulse Direct');
    await c.d.ciclo({ origem: 'manual' });
    simuladas = (await c.decisoes()).filter((d) => d.resultado === 'simulado');
    assert.equal(simuladas.length, 6, 'não repete a mesma decisão');
    const primeira = filaDe(c.pulse, 'A')[0];
    c.pulse.mudar(primeira, { userId: 'caio', status: 'IN_PROGRESS' });
    await c.d.ciclo({ origem: 'manual' });
    const desfecho = (await c.decisoes()).find((d) => d.resultado === 'desfecho' && d.conversaId === primeira.id);
    assert.match(desfecho.detalhe, /Saiu da fila com Caio \(o sistema mandaria para Bia\)/);
  } finally {
    await c.fechar();
  }
});

caso('sem equipe incluída nada é distribuído, e o painel pede para incluir', async () => {
  const c = await cenario({ configurar: base });
  try {
    const r = await c.d.ciclo({ origem: 'manual' });
    assert.equal(r.decisoes, 0);
    assert.ok((await c.d.painel()).avisos.some((a) => /Nenhuma equipe incluída/.test(a)));
  } finally {
    await c.fechar();
  }
});

// ---------- distribuição ligada ----------

caso('ligada: completa até 15, mais antiga primeiro, sem nenhuma entrega errada', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    const fila = filaDe(c.pulse, 'A').map((x) => x.id);
    await c.d.ciclo({ origem: 'manual' });
    assert.deepEqual(c.pulse.violacoes, []);
    assert.equal(c.pulse.abertasDe('ana'), 15);
    assert.equal(c.pulse.abertasDe('bia'), 15);
    assert.deepEqual(c.pulse.puts.map((p) => p.conversaId), fila.slice(0, 6), 'as 6 mais antigas');
    assert.equal((await c.d.painel()).equipes.find((e) => e.id === 'A').aguardando, 2);
  } finally {
    await c.fechar();
  }
});

caso('ligada: conversa que ganhou dono no meio do caminho não é tomada', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    const alvo = filaDe(c.pulse, 'A')[0];
    c.pulse.aoObterConversa = (x) => { if (x.id === alvo.id) c.pulse.mudar(x, { userId: 'caio', status: 'IN_PROGRESS' }); };
    await c.d.ciclo({ origem: 'manual' });
    assert.ok(!c.pulse.puts.some((p) => p.conversaId === alvo.id));
    assert.deepEqual(c.pulse.violacoes, []);
    assert.ok((await c.decisoes()).some((d) => d.conversaId === alvo.id && d.resultado === 'ignorado'));
  } finally {
    await c.fechar();
  }
});

caso('ligada: 429 na atribuição não é repetido; o ciclo seguinte reconfere e entrega', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    c.pulse.falhar429NoPut = 1;
    await c.d.ciclo({ origem: 'manual' });
    assert.equal(c.pulse.puts.length, 0, 'parou o lote no 429');
    assert.equal((await c.decisoes()).filter((d) => d.resultado === 'erro').length, 1);
    await c.d.ciclo({ origem: 'manual' });
    assert.equal(c.pulse.puts.length, 6);
    assert.deepEqual(c.pulse.violacoes, []);
  } finally {
    await c.fechar();
  }
});

caso('ligada: equipe com a distribuição do próprio Pulse Direct ligada fica de fora (e avisa)', async () => {
  const c = await cenario({ configurar: (p) => { base(p); p.equipes.get('A').distribuicao = true; } });
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    await c.d.ciclo({ origem: 'manual' });
    assert.equal(c.pulse.puts.length, 0);
    const p = await c.d.painel();
    assert.ok(p.avisos.some((a) => /distribuição do próprio Pulse Direct está ligada/.test(a)));
    assert.equal(p.equipes.find((e) => e.id === 'A').quemDistribui, 'pulse');
  } finally {
    await c.fechar();
  }
});

caso('volta atrás rápida: religar a distribuição do Pulse Direct vale já na próxima entrega', async () => {
  let t = Date.now();
  const c = await cenario({ configurar: base, agora: () => t });
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    await c.d.ciclo({ origem: 'manual' });
    assert.equal(c.pulse.puts.length, 6);
    for (let i = 0; i < 5; i++) c.pulse.novaConversa({ departmentId: 'A' });
    const daAna = [...c.pulse.conversas.values()].find((x) => x.userId === 'ana' && x.status === 'IN_PROGRESS');
    c.pulse.mudar(daAna, { status: 'COMPLETED', endAt: c.pulse.agora() });
    c.pulse.equipes.get('A').distribuicao = true; // alguém religou no Pulse Direct
    t += 30_000; // equipes ainda "frescas" para o ciclo (2 min), mas velhas para entregar (20 s)
    await c.d.ciclo({ origem: 'manual' });
    assert.equal(c.pulse.puts.length, 6, 'não entregou mais nada em Exames');
  } finally {
    await c.fechar();
  }
});

// ---------- gestão de equipe e configuração ----------

caso('gestão: trocar de equipe (tirar de uma e colocar em outra) vale no Pulse Direct e fica registrado', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.d.ciclo({ origem: 'manual' });
    const r = await c.d.mudarEquipesDoAtendente('ana', { adicionar: ['B'], remover: ['A'] }, 'Admin Teste');
    assert.deepEqual(r.falhas, []);
    assert.deepEqual(c.pulse.agentes.get('ana').equipes, ['B']);
    assert.ok(c.linhas.some((l) => l.tipo === 'gestao_equipe' && l.mensagem === 'Admin Teste tirou Ana de Exames e colocou Ana em Cirurgia.'));
    await c.d.ciclo({ origem: 'manual' });
    const ana = (await c.d.painel()).atendentes.find((a) => a.userId === 'ana');
    assert.deepEqual(ana.equipes.map((e) => e.nome), ['Cirurgia']);
    assert.deepEqual(ana.porEquipe, [{ id: 'A', nome: 'Exames', n: 14, membro: false }], 'as conversas abertas continuam com ela');
    assert.ok(c.tipos().includes('atendente_saiu_equipe') && c.tipos().includes('atendente_entrou_equipe'));
    await assert.rejects(c.d.mudarEquipesDoAtendente('ana', { adicionar: ['NAO-EXISTE'] }, 'Admin'), /Equipe não encontrada/);
  } finally {
    await c.fechar();
  }
});

caso('gestão: configurar equipe (nome e distribuição do Pulse no Pulse; inclusão no sistema)', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.d.ciclo({ origem: 'manual' });
    await c.d.configurarEquipe('A', { nome: ' Exames Laboratoriais ', distribuicaoNativa: true, incluir: true }, 'Admin');
    assert.equal(c.pulse.equipes.get('A').nome, 'Exames Laboratoriais');
    assert.equal(c.pulse.equipes.get('A').distribuicao, true);
    assert.equal((await c.d.lerConfig()).equipes.A, true);
    await c.d.configurarEquipe('A', { incluir: false }, 'Admin');
    assert.equal((await c.d.lerConfig()).equipes.A, undefined);
    assert.ok(c.linhas.some((l) => /Admin configurou a equipe Exames: renomeou para "Exames Laboratoriais" e ligou a distribuição do próprio Pulse Direct/.test(l.mensagem)));
    await assert.rejects(c.d.configurarEquipe('X', { incluir: true }, 'Admin'), /Equipe não encontrada/);
    await assert.rejects(c.d.configurarEquipe('A', { nome: '  ' }, 'Admin'), /Informe o nome/);
  } finally {
    await c.fechar();
  }
});

caso('ligar/desligar e configurações ficam salvas e registradas, com validação', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.d.ligar(true, 'Admin');
    assert.equal((await c.d.lerConfig()).ligado, true);
    await c.d.ligar(false, 'Admin');
    assert.equal((await c.d.lerConfig()).ligado, false);
    assert.ok(c.tipos().includes('distribuicao_ligada') && c.tipos().includes('distribuicao_desligada'));
    await assert.rejects(c.d.salvarConfig({ teto: 0 }, 'Admin'), /Teto por atendente/);
    await c.d.salvarConfig({ teto: 12, maxPorCiclo: 2, alertaFilaMin: 45 }, 'Admin');
    assert.deepEqual((({ teto, maxPorCiclo, alertaFilaMin }) => ({ teto, maxPorCiclo, alertaFilaMin }))(await c.d.lerConfig()), { teto: 12, maxPorCiclo: 2, alertaFilaMin: 45 });
  } finally {
    await c.fechar();
  }
});

caso('ligar assume as equipes incluídas (desliga a do Pulse) e desligar devolve (religa)', async () => {
  const c = await cenario({ configurar: base });
  try {
    c.pulse.equipes.get('A').distribuicao = true;
    c.pulse.equipes.get('B').distribuicao = true;
    await c.config({ equipes: { A: true } });
    const r = await c.d.ligar(true, 'Admin', { trocarPulse: true });
    assert.deepEqual(r.trocadas, ['Exames']);
    assert.equal(c.pulse.equipes.get('A').distribuicao, false, 'incluída: o sistema assume');
    assert.equal(c.pulse.equipes.get('B').distribuicao, true, 'não incluída: ninguém mexe');
    await c.d.ligar(false, 'Admin', { trocarPulse: true });
    assert.equal(c.pulse.equipes.get('A').distribuicao, true, 'desligar devolve ao Pulse Direct');
    assert.equal((await c.d.lerConfig()).ligado, false);
  } finally {
    await c.fechar();
  }
});

caso('listagem de equipes do Pulse em cache: vale o que o sistema acabou de gravar', async () => {
  const c = await cenario({ configurar: base });
  try {
    c.pulse.equipes.get('A').distribuicao = true;
    await c.config({ ligado: true });
    await c.d.configurarEquipe('A', { distribuicaoNativa: false, incluir: true }, 'Admin');
    c.pulse.equipes.get('A').distribuicao = true; // a listagem ainda devolve o valor antigo
    await c.d.ciclo({ origem: 'manual' });
    assert.ok(c.pulse.puts.length > 0, 'distribuiu mesmo com a listagem atrasada');
    assert.deepEqual(c.pulse.violacoes, []);
  } finally {
    await c.fechar();
  }
});

caso('equipe com fila e sem ninguém distribuindo vira aviso', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.config({ ligado: true });
    await c.d.ciclo({ origem: 'manual' });
    assert.ok((await c.d.painel()).avisos.some((a) => /Ninguém distribui Exames \(8 na fila\)/.test(a)));
  } finally {
    await c.fechar();
  }
});

// ---------- equalização ----------

const HORA = 3_600_000;
/** Ana online com 20 (12 pendentes); Beto offline há 30 h; Carla offline há 2 h; Dani com vaga; Solo sozinho na equipe S; Zé offline no Pulse mas em pausa na Gestão de Pausas. */
function equalizar(p) {
  p.equipe('A', 'Exames');
  p.equipe('S', 'Solo');
  p.agente('ana', ['A'], true, 'Ana');
  p.agente('beto', ['A'], false, 'Beto', Date.now() - 30 * HORA);
  p.agente('carla', ['A'], false, 'Carla', Date.now() - 2 * HORA);
  p.agente('dani', ['A'], true, 'Dani');
  p.agente('solo', ['S'], false, 'Solo', Date.now() - 48 * HORA);
  p.agente('ze', ['A'], false, 'Zé', Date.now() - 30 * HORA);
  for (let i = 0; i < 20; i++) p.novaConversa({ departmentId: 'A', userId: 'ana', status: i % 5 < 3 ? 'PENDING' : 'IN_PROGRESS' });
  for (let i = 0; i < 8; i++) p.novaConversa({ departmentId: 'A', userId: 'beto', status: i < 6 ? 'PENDING' : 'IN_PROGRESS' });
  for (let i = 0; i < 4; i++) p.novaConversa({ departmentId: 'A', userId: 'carla' });
  for (let i = 0; i < 3; i++) p.novaConversa({ departmentId: 'A', userId: 'dani', status: 'IN_PROGRESS' });
  for (let i = 0; i < 3; i++) p.novaConversa({ departmentId: 'S', userId: 'solo' });
  for (let i = 0; i < 2; i++) p.novaConversa({ departmentId: 'A', userId: 'ze' });
}

async function comZeEmPausa(c) {
  const t = Date.now();
  const [u] = await c.sql`INSERT INTO users (email, name, crm_user_id, created_at, updated_at) VALUES ('ze.equalizacao@teste.com', 'Zé', 'ze', ${t}, ${t}) RETURNING id`;
  await c.sql`INSERT INTO intervals (user_id, kind, reason_name, started_at) VALUES (${u.id}, 'pause', 'Almoço', ${t - 10 * 60_000})`;
  return async () => {
    await c.sql`DELETE FROM intervals WHERE user_id = ${u.id}`;
    await c.sql`DELETE FROM users WHERE id = ${u.id}`;
  };
}

caso('equalização (prévia): pendentes acima do teto e de quem está offline há 24 h; nada em atendimento', async () => {
  const c = await cenario({ configurar: equalizar });
  const limparZe = await comZeEmPausa(c);
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    await c.d.ciclo({ origem: 'manual' });
    const plano = await c.d.planoEqualizacao();
    const g = Object.fromEntries(plano.grupos.map((x) => [x.userId, x]));
    assert.deepEqual(Object.keys(g).sort(), ['ana', 'beto'], 'Carla (2 h) e Zé (em pausa na Gestão de Pausas) ficam; Solo é a única da equipe');
    assert.equal(g.ana.motivo, 'acima_do_teto');
    const pendentesAna = [...c.pulse.conversas.values()].filter((x) => x.userId === 'ana' && x.status === 'PENDING').map((x) => x.id);
    assert.deepEqual(g.ana.conversas.map((x) => x.conversaId), pendentesAna.slice(-5), 'as 5 pendentes mais novas (volta a 15)');
    assert.equal(g.beto.motivo, 'offline');
    assert.ok(g.beto.offlineHoras >= 30);
    assert.equal(g.beto.conversas.length, 6, 'só as pendentes; as 2 em atendimento ficam');
    assert.equal(plano.total, 11);
    assert.equal(plano.ignoradas.filter((x) => x.userId === 'solo' && /única pessoa/.test(x.detalhe)).length, 3);
    assert.equal(c.pulse.transferencias.length, 0, 'a prévia não mexe em nada');
  } finally {
    await limparZe();
    await c.fechar();
  }
});

caso('equalização (execução): devolve só o confirmado, reconfere cada uma, e a distribuição reparte', async () => {
  const c = await cenario({ configurar: equalizar });
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    await c.d.ciclo({ origem: 'manual' });
    const plano = await c.d.planoEqualizacao();
    const ids = plano.grupos.flatMap((g) => g.conversas.map((x) => x.conversaId));
    const mudou = plano.grupos.find((g) => g.userId === 'beto').conversas[0].conversaId;
    c.pulse.mudar(c.pulse.conversas.get(mudou), { status: 'IN_PROGRESS' }); // Beto voltou e atendeu essa
    const emAtendimentoAna = [...c.pulse.conversas.values()].find((x) => x.userId === 'ana' && x.status === 'IN_PROGRESS').id;
    const r = await c.d.executarEqualizacao([...ids, emAtendimentoAna], 'Admin');
    assert.equal(r.feitas, ids.length - 1);
    assert.equal(r.mudaram, 1);
    assert.equal(r.foraDoPlano, 1, 'conversa em atendimento pedida por fora do plano é ignorada');
    assert.equal(c.pulse.abertasDe('ana'), 15);
    assert.equal(c.pulse.abertasDe('beto'), 3, 'as 2 em atendimento e a que ele pegou');
    assert.equal(c.pulse.conversas.get(mudou).userId, 'beto');
    assert.equal(c.pulse.conversas.get(emAtendimentoAna).userId, 'ana');
    await c.d.ciclo({ origem: 'manual' });
    assert.deepEqual(c.pulse.violacoes, []);
    assert.ok(c.pulse.puts.length > 0 && c.pulse.puts.every((p) => p.userId === 'dani'), 'quem tem vaga e está online recebe');
    assert.ok((await c.decisoes()).some((d) => d.modo === 'equalizacao' && d.resultado === 'devolvido'));
  } finally {
    await c.fechar();
  }
});

caso('equalização: se o Pulse Direct mantiver o atendente, para na primeira', async () => {
  const c = await cenario({ configurar: equalizar });
  try {
    await c.config({ ligado: true, equipes: { A: true } });
    await c.d.ciclo({ origem: 'manual' });
    c.pulse.transferenciaMantemDono = true;
    const plano = await c.d.planoEqualizacao();
    const r = await c.d.executarEqualizacao(plano.grupos.flatMap((g) => g.conversas.map((x) => x.conversaId)), 'Admin');
    assert.equal(r.feitas, 0);
    assert.match(r.parou, /manteve o atendente/);
    assert.equal(c.pulse.transferencias.length, 1);
  } finally {
    await c.fechar();
  }
});

// ---------- gatilhos, trava e leitura ----------

caso('ciclos não se sobrepõem e, exceto o manual, respeitam o intervalo mínimo', async () => {
  const c = await cenario({ configurar: base });
  try {
    const [a, b] = await Promise.all([c.d.ciclo({ origem: 'painel' }), c.d.ciclo({ origem: 'painel' })]);
    assert.deepEqual([a.executado, b.executado].sort(), [false, true]);
    assert.equal((await c.d.ciclo({ origem: 'painel' })).motivo, 'recente');
    assert.equal((await c.d.ciclo({ origem: 'manual' })).executado, true);
  } finally {
    await c.fechar();
  }
});

caso('eventos em rajada: um só fica responsável e roda o ciclo quando o intervalo mínimo abre', async () => {
  let deslocamento = 0;
  const dormidas = [];
  const c = await cenario({
    configurar: base,
    agora: () => Date.now() + deslocamento,
    // cede a vez de verdade: com a espera instantânea a 1ª chamada solta a trava antes das outras chegarem
    dormir: async (ms) => { dormidas.push(ms); deslocamento += ms; await new Promise((r) => setTimeout(r, 300)); },
  });
  try {
    await c.d.ciclo({ origem: 'manual' });
    const r = await Promise.all(Array.from({ length: 5 }, () => c.d.aoEvento()));
    assert.equal(r.filter((x) => x.executado).length, 1, 'um ciclo só');
    assert.equal(r.filter((x) => x.motivo === 'agendado').length, 4);
    assert.ok(dormidas.some((ms) => ms > 9_000), 'esperou o intervalo mínimo');
    assert.ok((await c.d.painel()).gatilhos.evento);
  } finally {
    await c.fechar();
  }
});

caso('releitura completa em pedaços quando não cabe num ciclo (conta grande)', async () => {
  const c = await cenario({
    configurar: (p) => {
      p.equipe('A', 'Exames');
      p.agente('ana', ['A']);
      for (let i = 0; i < 450; i++) p.novaConversa({ departmentId: 'A', userId: 'ana', status: 'PENDING' });
    },
  });
  try {
    await c.d.ciclo({ origem: 'manual', prazoMs: 4_800 }); // cabe 1 página por ciclo
    let p = await c.d.painel();
    assert.equal(p.leituraCompleta, false);
    for (let i = 0; i < 8 && !p.leituraCompleta; i++) {
      await c.d.ciclo({ origem: 'manual', prazoMs: 4_800 });
      p = await c.d.painel();
    }
    assert.equal(p.leituraCompleta, true);
    assert.equal(p.resumo.abertasComAtendentes, 450);
    assert.ok(!p.avisos.some((a) => /Pulse Direct informa/.test(a)), 'autoconferência bate');
  } finally {
    await c.fechar();
  }
});

caso('transferência em massa: 250 conversas alteradas no mesmo instante aparecem todas', async () => {
  const instante = Date.now() - 60_000;
  const c = await cenario({
    configurar: (p) => {
      p.equipe('A', 'Exames');
      p.agente('ana', ['A'], false);
      for (let i = 0; i < 250; i++) p.novaConversa({ departmentId: 'A', createdAt: instante - 1000, updatedAt: instante });
    },
  });
  try {
    await c.d.ciclo({ origem: 'manual' });
    assert.equal((await c.d.painel()).equipes.find((e) => e.id === 'A').aguardando, 250);
  } finally {
    await c.fechar();
  }
});

caso('autoconferência: total do Pulse Direct bem diferente do lido vira aviso', async () => {
  const c = await cenario({ configurar: (p) => { base(p); p.desvioTotal = 500; } });
  try {
    await c.d.ciclo({ origem: 'manual' });
    assert.ok(c.tipos().includes('leitura_divergente'));
    assert.ok((await c.d.painel()).avisos.some((a) => /o Pulse Direct informa/.test(a)));
  } finally {
    await c.fechar();
  }
});

caso('auto-manutenção: mudanças no Pulse Direct aparecem no registro e valem no ciclo seguinte', async () => {
  const c = await cenario({ configurar: base });
  try {
    await c.config({ ligado: true, equipes: { A: true, B: true } });
    await c.d.ciclo({ origem: 'manual' }); // Ana e Bia completam 15
    c.pulse.agentes.get('ana').equipes = ['B'];
    c.pulse.agentes.delete('bia');
    c.pulse.agentes.get('caio').disponivel = true;
    c.pulse.agente('dani', ['A'], true, 'Dani');
    c.pulse.novaConversa({ departmentId: 'B' });
    const daAna = [...c.pulse.conversas.values()].find((x) => x.userId === 'ana' && x.status === 'IN_PROGRESS');
    c.pulse.mudar(daAna, { status: 'COMPLETED', endAt: c.pulse.agora() });
    await c.d.ciclo({ origem: 'manual' });
    for (const tipo of ['atendente_saiu_equipe', 'atendente_entrou_equipe', 'atendente_removido', 'atendente_novo', 'atendente_online']) {
      assert.ok(c.tipos().includes(tipo), tipo);
    }
    const novos = c.pulse.puts.slice(6);
    assert.ok(novos.some((p) => p.userId === 'ana' && c.pulse.conversas.get(p.conversaId).departmentId === 'B'), 'Ana recebeu da equipe nova');
    assert.ok(novos.filter((p) => c.pulse.conversas.get(p.conversaId).departmentId === 'A').every((p) => ['caio', 'dani'].includes(p.userId)));
    assert.deepEqual(c.pulse.violacoes, []);
  } finally {
    await c.fechar();
  }
});

caso('painel: abertos por equipe (inclusive de equipe da qual não é atendente), vagas e concluídos hoje', async () => {
  const c = await cenario({
    configurar: (p) => {
      base(p);
      p.novaConversa({ departmentId: 'BOT', userId: 'ana', status: 'PENDING' });
      for (let i = 0; i < 3; i++) p.novaConversa({ departmentId: 'A', userId: 'bia', status: 'COMPLETED', endAt: p.agora() });
    },
  });
  try {
    await c.d.ciclo({ origem: 'manual' });
    const p = await c.d.painel();
    const ana = p.atendentes.find((a) => a.userId === 'ana');
    assert.deepEqual(ana.porEquipe, [{ id: 'A', nome: 'Exames', n: 14, membro: true }, { id: 'BOT', nome: 'Chatbot', n: 1, membro: false }]);
    assert.deepEqual([ana.abertas, ana.vagas], [15, 0]);
    const bia = p.atendentes.find((a) => a.userId === 'bia');
    assert.deepEqual([bia.abertas, bia.pendentes, bia.emAtendimento, bia.vagas, bia.concluidasHoje], [10, 4, 6, 5, 3]);
    assert.equal(p.concluidasCarregadas, true);
    assert.equal(p.equipes.find((e) => e.id === 'BOT').quemDistribui, 'ninguem');
    assert.equal(p.resumo.onlineAcimaDoTeto, 0);
    // nada do conteúdo das conversas vai para o banco
    const [{ n }] = await c.sql`SELECT count(*)::int AS n FROM dist_eventos WHERE mensagem LIKE ${'%' + TEXTO_SENSIVEL + '%'}`;
    const [{ m }] = await c.sql`SELECT count(*)::int AS m FROM dist_estado WHERE valor::text LIKE ${'%' + TEXTO_SENSIVEL + '%'}`;
    assert.equal(n + m, 0);
  } finally {
    await c.fechar();
  }
});

caso('caos com a distribuição ligada: 20 ciclos sem nenhuma entrega errada e sem vaga ociosa no fim', async () => {
  let semente = 42;
  const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
  const ids = ['A', 'B', 'C', 'D'];
  const c = await cenario({
    configurar: (p) => {
      for (const id of ids) p.equipe(id);
      p.equipe('PULSE', 'Distribuída pelo Pulse', true);
      for (let i = 0; i < 20; i++) p.agente(`u${i}`, [ids[i % 4], ...(i % 5 === 0 ? [ids[(i + 1) % 4]] : [])], rnd() < 0.8);
      for (let i = 0; i < 20; i++) {
        const n = i < 2 ? 30 : Math.floor(rnd() * 16);
        for (let k = 0; k < n; k++) p.novaConversa({ departmentId: ids[i % 4], userId: `u${i}`, status: rnd() < 0.5 ? 'PENDING' : 'IN_PROGRESS' });
      }
      for (let k = 0; k < 120; k++) p.novaConversa({ departmentId: ids[Math.floor(rnd() * 4)] });
      for (let k = 0; k < 10; k++) p.novaConversa({ departmentId: 'PULSE' });
    },
  });
  try {
    await c.config({ ligado: true, maxPorCiclo: 3, equipes: Object.fromEntries([...ids, 'PULSE'].map((id) => [id, true])) });
    c.pulse.aoObterConversa = (x) => { if (!x.userId && rnd() < 0.1) c.pulse.mudar(x, { userId: 'u3', status: 'IN_PROGRESS' }); };
    for (let ciclo = 0; ciclo < 20; ciclo++) {
      await c.d.ciclo({ origem: 'manual' });
      for (const x of c.pulse.conversas.values()) {
        if (x.userId && (x.status === 'PENDING' || x.status === 'IN_PROGRESS') && rnd() < 0.15) c.pulse.mudar(x, { status: 'COMPLETED', endAt: c.pulse.agora() });
      }
      for (let k = 0; k < 6; k++) c.pulse.novaConversa({ departmentId: ids[Math.floor(rnd() * 4)] });
      for (const a of c.pulse.agentes.values()) if (rnd() < 0.08) a.disponivel = !a.disponivel;
      if (ciclo % 5 === 4) c.pulse.agentes.get(`u${Math.floor(rnd() * 20)}`).equipes = [ids[Math.floor(rnd() * 4)]];
    }
    assert.deepEqual(c.pulse.violacoes, []);
    assert.ok(c.pulse.puts.length > 60, `entregou ${c.pulse.puts.length}`);
    assert.ok(!c.pulse.puts.some((p) => c.pulse.conversas.get(p.conversaId).departmentId === 'PULSE'), 'não mexeu na equipe distribuída pelo Pulse');
    c.pulse.aoObterConversa = null;
    for (let i = 0; i < 30; i++) {
      const antes = c.pulse.puts.length;
      await c.d.ciclo({ origem: 'manual' });
      if (c.pulse.puts.length === antes) break;
    }
    assert.deepEqual(c.pulse.violacoes, []);
    for (const id of ids) {
      const esperando = filaDe(c.pulse, id).length;
      const comVaga = [...c.pulse.agentes.values()].filter((a) => a.disponivel && a.equipes.includes(id) && c.pulse.abertasDe(a.userId) < 15);
      assert.ok(esperando === 0 || comVaga.length === 0, `equipe ${id}: ${esperando} esperando e ${comVaga.length} online com vaga`);
    }
  } finally {
    await c.fechar();
  }
});
