// Motor da distribuição automática, no formato serverless: cada execução faz UM ciclo curto
// (com prazo), lendo e gravando o estado no banco. Quem dispara: o painel aberto (se os dados
// estiverem velhos), os eventos de conversa do Pulse Direct (webhook) e um agendador opcional.
//
// Regra: a conversa mais antiga da fila vai para o atendente ONLINE daquela equipe com mais vagas.
// Contam como abertas as pendentes e as em atendimento, até o atendente finalizar. Teto padrão: 15.
import { randomUUID } from 'node:crypto';
import { alocar } from './alocador.js';
import { mudancasAtendentes, mudancasEquipes, resumirAtendentes, resumirEquipes } from './mudancas.js';
import { inicioDoDia } from './datas.js';
import { AtribuicaoBloqueada, ErroPulse } from './pulse.js';

export const CONFIG_PADRAO = Object.freeze({ ligado: false, teto: 15, maxPorCiclo: 3, alertaFilaMin: 30, equipes: {} });

const FILTROS_ABERTAS = [['Status', 'STARTED'], ['Status', 'PENDING'], ['Status', 'IN_PROGRESS']];
const DESDE_SEMPRE = Date.UTC(2000, 0, 1);
const SOBREPOSICAO_MS = 120_000;
const RECONCILIAR_MS = 10 * 60_000;
const EQUIPES_A_CADA_MS = 2 * 60_000;
const CONCLUIDAS_A_CADA_MS = 3 * 3_600_000;
const PAGINAS_INCREMENTAL = 20;
const PAGINAS_RECONCILIACAO = 20;
const PAGINAS_CONCLUIDAS = 10;
const MAX_AUSENTES = 40;
/** Intervalo mínimo entre ciclos, mesmo com enxurrada de eventos. */
export const CICLO_MINIMO_MS = 10_000;
const TRAVA_MS = 60_000;
const CUSTO_POR_ATRIBUICAO = 3; // conferir conversa + contar abertas + atribuir
const RESERVA_REQ = 20;
/** Um lote de entregas não passa disso; o resto fica para o próximo ciclo (que relê tudo). */
const LOTE_MAX_MS = 15_000;
const RELER_ATENDENTES_MS = 15_000;
const RELER_EQUIPES_ANTES_DE_ENTREGAR_MS = 20_000;
/** Entre conferir a conversa e atribuir, no máximo isso; senão desiste e reconfere no próximo ciclo. */
const CONFERENCIA_MAX_MS = 3_000;
/** Contagem exata vista no Pulse Direct vale como piso da carga por este tempo (se o espelho não souber nada mais novo). */
const CORRECAO_MS = 60_000;
const BLOQUEIO_MS = 30 * 60_000;
const NOME_ASSINATURA = 'Gestão de Pausas · Distribuição automática';

const msg = (e) => (e instanceof Error ? e.message : String(e));

export class Distribuidor {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./estado.js').criarEstado>} deps.estado
   * @param {(o: {permitirAtribuir: boolean, aoChamar: Function, aoLimite: Function, instantes: number[]}) => import('./pulse.js').ClientePulse} deps.criarPulse
   * @param {import('./registro.js').Registro} deps.log
   */
  constructor({ estado, criarPulse, log, agora = Date.now, fuso = 'America/Sao_Paulo', orcamento5min = 250, dormir }) {
    this.estado = estado;
    this.criarPulse = criarPulse;
    this.log = log;
    this.agora = agora;
    this.fuso = fuso;
    this.orcamento5min = orcamento5min;
    this.dormir = dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---------- estado ----------

  async carregar() {
    const v = await this.estado.lerEstado();
    return {
      config: { ...CONFIG_PADRAO, ...(v.config ?? {}), equipes: { ...(v.config?.equipes ?? {}) } },
      marca: v.marca ?? null,
      reconciliacao: v.reconciliacao ?? { ultimaEm: 0, rodada: 0, emAndamento: null },
      concluidas: v.concluidas ?? { lidasEm: 0, carregadas: false, varredura: null },
      fotoAtendentes: v.foto_atendentes ?? null,
      fotoEquipes: v.foto_equipes ?? null,
      atendentes: v.atendentes ?? [],
      equipes: v.equipes ?? { lista: [], lidasEm: 0 },
      nomesAntigos: v.nomes_antigos ?? {},
      avisos: v.avisos ?? [],
      correcoes: v.correcoes ?? {},
      bloqueios: v.bloqueios ?? {},
      divergencia: v.divergencia ?? null,
      ausentesDemais: v.ausentes_demais ?? 0,
      erros: v.erros ?? { seguidos: 0, ultimo: null },
      ciclo: v.ciclo ?? { ultimoInicio: 0, ultimoOk: 0, ultimaDuracao: null, ultimaPoda: 0 },
      dia: v.dia ?? 0,
      semVaga: v.sem_vaga ?? {},
      gerenciadas: v.gerenciadas ?? [],
      gatilhos: { evento: v.gatilho_evento ?? null, agendador: v.gatilho_agendador ?? null },
      atendentesLidosEm: 0,
    };
  }

  /** Grava o que o ciclo mexe. A configuração NÃO: ela só muda por ação de administrador. */
  async salvar(st) {
    await this.estado.gravarEstado({
      marca: st.marca, reconciliacao: st.reconciliacao, concluidas: st.concluidas,
      foto_atendentes: st.fotoAtendentes, foto_equipes: st.fotoEquipes, atendentes: st.atendentes, equipes: st.equipes,
      nomes_antigos: st.nomesAntigos, avisos: st.avisos, correcoes: st.correcoes, bloqueios: st.bloqueios,
      divergencia: st.divergencia, ausentes_demais: st.ausentesDemais, erros: st.erros, ciclo: st.ciclo, dia: st.dia,
      sem_vaga: st.semVaga, gerenciadas: st.gerenciadas,
    }, this.agora());
  }

  async lerConfig() {
    const { config } = await this.estado.lerEstado(['config']);
    return { ...CONFIG_PADRAO, ...(config ?? {}), equipes: { ...(config?.equipes ?? {}) } };
  }

  async novoPulse(permitirAtribuir, pendentes) {
    const instantes = await this.estado.instantesChamadas(this.agora() - 300_000);
    let ultimoAviso429 = 0;
    return this.criarPulse({
      permitirAtribuir,
      instantes,
      aoChamar: (c) => {
        pendentes.push(this.estado.registrarChamada({ em: Date.now(), ...c }).catch(() => {}));
        if (c.status === 0 || c.status >= 400) {
          this.log.trilha('chamada', `${c.metodo} ${c.caminho} → ${c.status || 'falha de rede'} (${c.duracaoMs} ms)`, c, c.status === 0 || c.status >= 500 ? 'erro' : 'aviso');
        }
      },
      aoLimite: (pausaMs) => {
        if (Date.now() - ultimoAviso429 > 60_000) {
          ultimoAviso429 = Date.now();
          pendentes.push(this.log.aviso('limite_requisicoes', `O Pulse Direct devolveu 429 (limite de requisições da conta). Pausando ${pausaMs / 1000} s.`));
        }
      },
    });
  }

  // ---------- ciclo ----------

  /**
   * Um ciclo: sincroniza, decide e (se ligada) entrega. `origem`: painel | evento | agendador | manual.
   * Ciclos não se sobrepõem (trava no banco) e, exceto o manual, respeitam o intervalo mínimo.
   */
  async ciclo({ origem = 'painel', prazoMs = 20_000 } = {}) {
    const inicio = this.agora();
    const dono = randomUUID();
    if (!(await this.estado.adquirirTrava('ciclo', dono, inicio, TRAVA_MS))) return { executado: false, motivo: 'em_andamento' };
    let st;
    try {
      st = await this.carregar();
    } catch (e) {
      await this.estado.liberarTrava('ciclo', dono);
      throw e;
    }
    if (origem !== 'manual' && st.ciclo.ultimoInicio && inicio - st.ciclo.ultimoInicio < CICLO_MINIMO_MS) {
      await this.estado.liberarTrava('ciclo', dono);
      return { executado: false, motivo: 'recente' };
    }
    st.ciclo.ultimoInicio = inicio;
    const prazo = inicio + prazoMs;
    const pendentes = [];
    let pulse = null;
    let decisoes = 0;
    let erro = null;
    try {
      pulse = await this.novoPulse(st.config.ligado, pendentes);
      await this.sincronizar(st, pulse, inicio, prazo);
      decisoes = await this.distribuir(st, pulse, prazo, dono);
      if (prazo - this.agora() > 5_000) await this.avancarConcluidas(st, pulse);
      if (st.erros.seguidos > 0) await this.log.info('ciclo_recuperado', `Voltou a funcionar depois de ${st.erros.seguidos} ciclo(s) com erro.`);
      st.erros = { seguidos: 0, ultimo: null };
      st.ciclo.ultimoOk = this.agora();
    } catch (e) {
      erro = msg(e);
      const n = (st.erros.seguidos ?? 0) + 1;
      st.erros = { seguidos: n, ultimo: { em: this.agora(), mensagem: erro } };
      // no banco: o primeiro erro e depois um a cada 10 (o stdout recebe todos)
      if (n === 1 || n % 10 === 0) await this.log.erro('ciclo_erro', `Erro no ciclo${n > 1 ? ` (${n} seguidos)` : ''}: ${erro}`);
      else await this.log.trilha('ciclo_erro', erro, { seguidos: n }, 'erro');
      if (e instanceof AtribuicaoBloqueada) await this.log.erro('atribuicao_bloqueada', 'Tentativa de atribuir com a distribuição desligada. Nada foi enviado.');
    } finally {
      const duracao = this.agora() - inicio;
      st.ciclo.ultimaDuracao = duracao;
      await Promise.allSettled(pendentes);
      try {
        if (inicio - (st.ciclo.ultimaPoda ?? 0) > 3_600_000) {
          await this.estado.podar(inicio);
          st.ciclo.ultimaPoda = inicio;
        }
        await this.salvar(st);
        await this.estado.registrarCiclo({ em: inicio, origem, duracaoMs: duracao, requisicoes: pulse?.totalRequisicoes() ?? 0, decisoes, erro });
      } catch (e) {
        // sem gravar o estado o próximo ciclo refaz o trabalho; o painel mostra "atualizado há…" parado
        erro = erro ?? `Falha ao gravar o estado no banco: ${msg(e)}`;
        await this.log.erro('banco_erro', `Falha ao gravar o estado da distribuição no banco: ${msg(e)}`);
      }
      await this.log.trilha('ciclo', `Ciclo (${origem}): ${duracao} ms, ${pulse?.totalRequisicoes() ?? 0} requisições, ${decisoes} decisões`, { origem, duracaoMs: duracao, decisoes, ok: !erro });
      await this.estado.liberarTrava('ciclo', dono);
    }
    return { executado: true, decisoes, erro, duracaoMs: this.agora() - inicio };
  }

  // ---------- leitura ----------

  async sincronizar(st, pulse, agora, prazo) {
    const inicioDia = inicioDoDia(agora, this.fuso);
    if (inicioDia !== st.dia) {
      if (st.dia) await this.log.trilha('virada_do_dia', 'Novo dia: contagem de concluídos zerada.');
      st.dia = inicioDia;
      await this.estado.podarConversas(inicioDia);
      st.concluidas = { lidasEm: 0, carregadas: false, varredura: null };
    }
    if (!st.equipes.lista.length || agora - st.equipes.lidasEm >= EQUIPES_A_CADA_MS) {
      await this.registrarEquipes(st, await pulse.listarEquipes());
      st.equipes.lidasEm = agora;
    }
    await this.lerAtendentes(st, pulse);
    const rec = st.reconciliacao;
    if (rec.emAndamento || !rec.ultimaEm || agora - rec.ultimaEm >= RECONCILIAR_MS || st.marca === null) {
      await this.reconciliar(st, pulse, inicioDia, prazo);
    }
    if (st.marca !== null) {
      // sobreposição: pega o que mudou durante a leitura anterior
      const lote = await pulse.listarAtualizadas([], st.marca - SOBREPOSICAO_MS, PAGINAS_INCREMENTAL);
      await this.estado.aplicarConversas(lote.conversas, { inicioDia });
      this.moverMarca(st, lote.ultimo, pulse);
      if (!lote.completo) await this.log.trilha('incremental_parcial', `Muita alteração de uma vez (${lote.conversas.length}); continua no próximo ciclo.`);
    }
  }

  /** Data no futuro (relógio errado) não move a marca, senão leituras seguintes pulariam conversas. */
  moverMarca(st, ultimo, pulse) {
    if (ultimo === null || ultimo > pulse.relogioPulse() + 5 * 60_000) return;
    st.marca = Math.max(st.marca ?? 0, ultimo);
  }

  async lerAtendentes(st, pulse) {
    await this.registrarAtendentes(st, await pulse.listarAtendentes());
    st.atendentesLidosEm = this.agora();
  }

  async registrarEquipes(st, novas) {
    for (const e of st.equipes.lista) st.nomesAntigos[e.id] = e.nome;
    const foto = resumirEquipes(novas);
    const primeira = st.fotoEquipes === null;
    if (st.fotoEquipes) {
      for (const m of mudancasEquipes(st.fotoEquipes, foto)) await this.log.registrar(m.nivel, m.tipo, m.mensagem, m.dados);
    } else if (primeira) {
      await this.log.info('equipes_carregadas', `${foto.length} equipes lidas do Pulse Direct.`);
    }
    st.fotoEquipes = foto;
    st.equipes.lista = novas;
  }

  async registrarAtendentes(st, novos) {
    const foto = resumirAtendentes(novos);
    if (st.fotoAtendentes) {
      const mudancas = mudancasAtendentes(st.fotoAtendentes, foto, (id) => this.nomeEquipe(st, id), { disponibilidade: true });
      for (const m of mudancas) await this.log.registrar(m.nivel, m.tipo, m.mensagem, m.dados);
    } else {
      const emEquipe = novos.filter((a) => a.equipes.length).length;
      await this.log.info('atendentes_carregados', `${novos.length} usuários lidos do Pulse Direct, ${emEquipe} atendem alguma equipe.`);
    }
    st.fotoAtendentes = foto;
    st.atendentes = novos.map((a) => ({ userId: a.userId, nome: a.nome, email: a.email ?? null, disponivel: a.disponivel, equipes: a.equipes }));
  }

  /** Releitura completa das abertas (em pedaços, se não couber num ciclo): corrige o que a incremental tenha perdido. */
  async reconciliar(st, pulse, inicioDia, prazo) {
    const rec = st.reconciliacao;
    if (!rec.emAndamento) {
      rec.emAndamento = { rodada: (rec.rodada ?? 0) + 1, cursor: DESDE_SEMPRE, relogioInicio: pulse.relogioPulse(), ultimo: null, inicio: this.agora() };
    }
    const run = rec.emAndamento;
    const paginas = Math.max(1, Math.min(PAGINAS_RECONCILIACAO, Math.floor((prazo - this.agora() - 4_000) / 700)));
    const lote = await pulse.listarAtualizadas(FILTROS_ABERTAS, run.cursor, paginas);
    await this.estado.aplicarConversas(lote.conversas, { inicioDia, leitura: run.rodada });
    if (lote.ultimo !== null) run.ultimo = Math.max(run.ultimo ?? 0, lote.ultimo);
    if (!lote.completo) {
      run.cursor = lote.cursor;
      return;
    }
    // marca: no relógio do Pulse Direct, sem passar do começo da leitura (o que mudou durante ela vem na incremental)
    const limite = run.relogioInicio - 60_000;
    const visto = Math.max(st.marca ?? Number.NEGATIVE_INFINITY, run.ultimo ?? Number.NEGATIVE_INFINITY);
    st.marca = Number.isFinite(visto) ? Math.min(visto, limite) : limite;
    // abertas no espelho que não vieram: finalizadas ou ocultadas. Confere uma a uma.
    const ausentes = await this.estado.ausentes(run.rodada, MAX_AUSENTES);
    let corrigidas = 0;
    for (const id of ausentes.ids) {
      if (prazo - this.agora() < 3_000) break;
      const c = await pulse.obterConversa(id);
      if (c) await this.estado.aplicarConversas([c], { inicioDia });
      else await this.estado.removerConversa(id);
      corrigidas++;
    }
    st.ausentesDemais = ausentes.total > MAX_AUSENTES ? ausentes.total : 0;
    await this.autoconferir(st, pulse, run.rodada);
    const primeira = !rec.ultimaEm;
    rec.ultimaEm = this.agora();
    rec.rodada = run.rodada;
    rec.emAndamento = null;
    const dados = { ausentes: ausentes.total, corrigidas, duracaoMs: this.agora() - run.inicio };
    if (primeira) await this.log.info('reconciliacao', 'Leitura completa inicial das conversas abertas concluída.', dados);
    else if (ausentes.total) await this.log.info('reconciliacao', `Releitura completa corrigiu ${corrigidas} conversa(s) que a leitura incremental perdeu.`, dados);
    else await this.log.trilha('reconciliacao', 'Releitura completa: nada a corrigir.', dados);
  }

  /** O total que o Pulse Direct informa para as abertas tem que bater (com folga) com o que a leitura trouxe. */
  async autoconferir(st, pulse, rodada) {
    try {
      const total = await pulse.contarConversas(FILTROS_ABERTAS);
      const [{ n: lidas }] = await this.estado.contarLidas(rodada);
      const folga = Math.max(10, Math.ceil(total * 0.02));
      const antes = st.divergencia;
      st.divergencia = Math.abs(total - lidas) > folga
        ? `A leitura completa trouxe ${lidas} conversas abertas, mas o Pulse Direct informa ${total}. Pode haver conversa fora do alcance do sistema.`
        : null;
      if (st.divergencia && !antes) await this.log.aviso('leitura_divergente', st.divergencia, { lidas, total });
    } catch (e) {
      await this.log.trilha('autoconferencia_falhou', msg(e), undefined, 'aviso');
    }
  }

  /** Concluídas de hoje (só para a coluna "concluídos hoje"): em pedaços, depois da distribuição e com orçamento sobrando. */
  async avancarConcluidas(st, pulse) {
    const agora = this.agora();
    const c = st.concluidas;
    if (!c.varredura && c.lidasEm && agora - c.lidasEm < CONCLUIDAS_A_CADA_MS) return;
    if (pulse.requisicoesRestantes() < RESERVA_REQ + PAGINAS_CONCLUIDAS) return;
    const inicioDia = st.dia || inicioDoDia(agora, this.fuso);
    if (!c.varredura || c.varredura.dia !== inicioDia) {
      c.varredura = { cursor: { desdeUs: (inicioDia - 1) * 1000, pagina: 1 }, dia: inicioDia, inicio: agora, falhou: false };
    }
    const v = c.varredura;
    try {
      const lote = await pulse.listarAtualizadas(
        [['Status', 'COMPLETED'], ['EndAt.After', new Date(inicioDia).toISOString()]], v.cursor, PAGINAS_CONCLUIDAS);
      await this.estado.aplicarConversas(lote.conversas, { inicioDia });
      v.cursor = lote.cursor; // sempre avança (por data ou por página dentro de um empate)
      if (lote.completo) {
        c.lidasEm = v.inicio;
        c.carregadas = true;
        c.varredura = null;
        await this.log.trilha('concluidas', 'Concluídas de hoje lidas.', { duracaoMs: this.agora() - v.inicio });
      }
    } catch (e) {
      // não impede a distribuição: tenta de novo no próximo ciclo
      if (!v.falhou) await this.log.aviso('concluidas_falhou', `Não deu para ler as concluídas de hoje agora (tenta de novo no próximo ciclo): ${msg(e)}`);
      v.falhou = true;
    }
  }

  // ---------- decisão ----------

  nomeEquipe(st, id) {
    if (!id) return 'Sem equipe';
    return st.equipes.lista.find((e) => e.id === id)?.nome ?? st.nomesAntigos[id] ?? 'Equipe removida';
  }

  nomeAtendente(st, userId) {
    return st.atendentes.find((a) => a.userId === userId)?.nome ?? 'Usuário removido';
  }

  /** Equipes que o sistema distribui (incluídas pelo admin, com atendente humano), e avisos. */
  calcularGerenciadas(st, cargaPorAtendente, fila) {
    const avisos = [];
    const comHumano = new Set(st.atendentes.flatMap((a) => a.equipes));
    const incluidas = Object.entries(st.config.equipes).filter(([, v]) => v).map(([id]) => id);
    const existentes = new Map(st.equipes.lista.map((e) => [e.id, e]));
    let alvo = [];
    for (const id of incluidas) {
      const e = existentes.get(id);
      if (!e) avisos.push({ chave: `equipe_sumiu:${id}`, texto: `A equipe "${st.nomesAntigos[id] ?? id}" estava incluída na distribuição e não existe mais no Pulse Direct.` });
      else if (!comHumano.has(id)) avisos.push({ chave: `equipe_sem_humano:${id}`, texto: `${e.nome} está incluída na distribuição, mas não tem nenhum atendente.` });
      else alvo.push(e);
    }
    if (!incluidas.length) avisos.push({ chave: 'nenhuma_equipe', texto: 'Nenhuma equipe incluída na distribuição automática ainda. Inclua na aba Equipes (botão Configurar).' });
    const comNativa = alvo.filter((e) => e.distribuicaoNativa).map((e) => e.nome);
    if (comNativa.length) {
      avisos.push({
        chave: 'distribuicao_nativa',
        texto: st.config.ligado
          ? `${comNativa.join(', ')}: a distribuição do próprio Pulse Direct está ligada; o sistema não mexe nessa(s) equipe(s) até ela ser desligada (botão Configurar).`
          : `${comNativa.join(', ')}: a distribuição do próprio Pulse Direct está ligada; com ela ligada a fila fica vazia (desligue em Configurar antes de ligar a distribuição automática).`,
      });
    }
    if (st.config.ligado) alvo = alvo.filter((e) => !e.distribuicaoNativa);
    st.gerenciadas = alvo.map((e) => e.id);

    const conhecidos = new Set(st.atendentes.map((a) => a.userId));
    const orfas = [...cargaPorAtendente.entries()].filter(([u]) => !conhecidos.has(u)).reduce((s, [, c]) => s + c.total, 0);
    if (orfas) avisos.push({ chave: 'orfas', texto: `${orfas} conversa(s) abertas com usuário que não existe mais no Pulse Direct. Ninguém vê essas conversas.` });
    if (st.divergencia) avisos.push({ chave: 'leitura_divergente', texto: st.divergencia });
    if (st.ausentesDemais) avisos.push({ chave: 'ausentes', texto: `A releitura achou ${st.ausentesDemais} conversas fora de sincronia (corrige ${MAX_AUSENTES} por vez).` });

    // filas paradas há mais tempo que o alerta (em equipes com atendente humano)
    const agora = this.agora();
    const limite = st.config.alertaFilaMin * 60_000;
    const paradas = [];
    for (const e of st.equipes.lista) {
      if (!comHumano.has(e.id)) continue;
      const daEquipe = fila.filter((c) => c.equipeId === e.id);
      if (!daEquipe.length) continue;
      const antiga = Math.min(...daEquipe.map((c) => c.criadaEm ?? agora));
      if (agora - antiga < limite) continue;
      const online = st.atendentes.some((a) => a.disponivel && a.equipes.includes(e.id));
      paradas.push(`${e.nome} (${daEquipe.length}${online ? '' : ', ninguém online'})`);
    }
    if (paradas.length) avisos.push({ chave: 'filas_paradas', texto: `Conversas esperando há mais de ${st.config.alertaFilaMin} min: ${paradas.join(', ')}.` });
    return { ids: new Set(st.gerenciadas), avisos };
  }

  async atualizarAvisos(st, novos) {
    const antes = new Map(st.avisos.map((a) => [a.chave, a]));
    const depois = new Map(novos.map((a) => [a.chave, a]));
    for (const [chave, a] of depois) if (!antes.has(chave)) await this.log.aviso('aviso_novo', a.texto, { chave });
    for (const [chave, a] of antes) if (!depois.has(chave)) await this.log.info('aviso_resolvido', `Resolvido: ${a.texto}`, { chave });
    st.avisos = novos;
  }

  /** Abertas por atendente (total, pendentes, em atendimento e por equipe), a partir do banco. */
  async cargaPorAtendente() {
    const m = new Map();
    for (const r of await this.estado.carga()) {
      const x = m.get(r.user_id) ?? { total: 0, pendentes: 0, emAtendimento: 0, porEquipe: {} };
      x.total += r.n;
      if (r.status === 'IN_PROGRESS') x.emAtendimento += r.n;
      else x.pendentes += r.n;
      const chave = r.equipe_id ?? '';
      x.porEquipe[chave] = (x.porEquipe[chave] ?? 0) + r.n;
      m.set(r.user_id, x);
    }
    return m;
  }

  /** Carga para decidir: o espelho, com a contagem exata vista no Pulse Direct como piso (enquanto o espelho não souber nada mais novo). */
  cargaParaDecidir(st, cargaPorAtendente) {
    const agora = this.agora();
    const carga = new Map([...cargaPorAtendente].map(([u, c]) => [u, c.total]));
    for (const [u, c] of Object.entries(st.correcoes)) {
      const espelho = carga.get(u) ?? 0;
      if (c.ate <= agora || espelho !== c.base) delete st.correcoes[u];
      else if (espelho < c.n) carga.set(u, c.n);
    }
    return carga;
  }

  async distribuir(st, pulse, prazo, dono) {
    const agora = this.agora();
    const cargaPorAtendente = await this.cargaPorAtendente();
    const fila = (await this.estado.fila()).map((r) => ({ id: r.id, equipeId: r.equipe_id, criadaEm: r.criada_em ?? 0 }));
    const { ids: gerenciadas, avisos } = this.calcularGerenciadas(st, cargaPorAtendente, fila);
    for (const [chave, ate] of Object.entries(st.bloqueios)) if (ate <= agora) delete st.bloqueios[chave];
    const ultimaEntrega = st.config.ligado ? await this.estado.ultimasEntregas(agora - 86_400_000) : new Map();

    const resultado = alocar({
      fila,
      atendentes: st.atendentes.map((a) => ({ userId: a.userId, nome: a.nome, online: a.disponivel, equipes: new Set(a.equipes) })),
      carga: this.cargaParaDecidir(st, cargaPorAtendente),
      ultimaEntrega,
      equipesGerenciadas: gerenciadas,
      teto: st.config.teto,
      maxPorAtendente: st.config.maxPorCiclo,
      maxTotal: fila.length,
      bloqueado: (c, u) => Boolean(st.bloqueios[`${c}|${u}`]),
    });
    st.semVaga = Object.fromEntries(resultado.semVaga);
    let decisoes = resultado.decisoes;
    if (st.config.ligado) {
      const cabem = Math.max(0, Math.floor((pulse.requisicoesRestantes() - RESERVA_REQ) / CUSTO_POR_ATRIBUICAO));
      if (decisoes.length > cabem) {
        avisos.push({ chave: 'orcamento_insuficiente', texto: `Faltou orçamento de requisições para entregar tudo agora (${cabem} de ${decisoes.length}). O resto sai nos próximos ciclos.` });
        decisoes = decisoes.slice(0, cabem);
      }
    }
    if (pulse.usoUltimos5min() > this.orcamento5min * 0.8) avisos.push({ chave: 'orcamento', texto: 'Uso de requisições acima de 80% do orçamento do sistema.' });
    await this.atualizarAvisos(st, avisos);

    if (!st.config.ligado) return this.registrarSimulacao(st, decisoes, new Set(fila.map((f) => f.id)));
    return this.executar(st, pulse, decisoes, prazo, dono);
  }

  async salvarDecisao(d) {
    await this.estado.registrarDecisao(d);
    const nivel = d.resultado === 'erro' ? 'erro' : d.resultado === 'ignorado' ? 'aviso' : 'info';
    await this.log.trilha(`decisao_${d.resultado}`, `${d.equipe}: conversa ${d.conversaId} → ${d.atendente || '—'}${d.detalhe ? ` (${d.detalhe})` : ''}`, {
      conversaId: d.conversaId, equipeId: d.equipeId, userId: d.userId, cargaAntes: d.cargaAntes, modo: d.modo,
    }, nivel);
  }

  /** Simulação: registra o que faria, uma vez por conversa, e depois o que de fato aconteceu com ela. */
  async registrarSimulacao(st, decisoes, naFila) {
    const agora = this.agora();
    const simuladas = await this.estado.simulacoes();
    const sairam = [...simuladas.keys()].filter((id) => !naFila.has(id));
    const conversas = await this.estado.obterConversas(sairam);
    let n = 0;
    for (const id of sairam) {
      const c = conversas.get(id);
      const simulado = simuladas.get(id);
      await this.salvarDecisao({
        em: agora, modo: 'simulacao', conversaId: id, equipeId: c?.equipe_id ?? null, equipe: this.nomeEquipe(st, c?.equipe_id ?? null),
        userId: c?.user_id ?? null, atendente: c?.user_id ? this.nomeAtendente(st, c.user_id) : null, cargaAntes: 0, resultado: 'desfecho',
        detalhe: c?.user_id
          ? `Saiu da fila com ${this.nomeAtendente(st, c.user_id)} (o sistema mandaria para ${this.nomeAtendente(st, simulado)}).`
          : `Saiu da fila sem atendente${c ? ` (status ${c.status})` : ''}.`,
      });
      n++;
    }
    await this.estado.removerSimulacoes(sairam);
    for (const d of decisoes) {
      if (simuladas.get(d.conversaId) === d.userId) continue;
      await this.estado.gravarSimulacao(d.conversaId, d.userId, agora);
      await this.salvarDecisao({
        em: agora, modo: 'simulacao', conversaId: d.conversaId, equipeId: d.equipeId, equipe: this.nomeEquipe(st, d.equipeId),
        userId: d.userId, atendente: this.nomeAtendente(st, d.userId), cargaAntes: d.cargaAntes, resultado: 'simulado',
      });
      n++;
    }
    return n;
  }

  corrigirCarga(st, userId, n, base) {
    st.correcoes[userId] = { n, base, ate: this.agora() + CORRECAO_MS };
  }

  /**
   * Distribuição ligada. Antes de CADA entrega: o ciclo continua dono da trava; a conversa continua
   * pendente, sem dono e na mesma equipe, e a contagem exata do atendente no Pulse Direct está abaixo
   * do teto — ambas lidas no máximo 3 s antes de atribuir; o atendente está online e na equipe numa
   * lista de no máximo 15 s. Qualquer falha passageira encerra o lote: o próximo ciclo relê tudo.
   */
  async executar(st, pulse, decisoes, prazo, dono) {
    if (!decisoes.length) return 0;
    const inicioLote = this.agora();
    const inicioDia = st.dia || inicioDoDia(inicioLote, this.fuso);
    const fimLote = Math.min(inicioLote + LOTE_MAX_MS, prazo - 2_000);
    let feitas = 0;
    const interromper = (motivo, nivel = 'info') => this.log.trilha('lote_interrompido', motivo, { feitas, decisoes: decisoes.length }, nivel);
    try {
      // volta atrás rápida: equipe que voltou para a distribuição do Pulse Direct sai já neste ciclo
      if (inicioLote - st.equipes.lidasEm > RELER_EQUIPES_ANTES_DE_ENTREGAR_MS) {
        await this.registrarEquipes(st, await pulse.listarEquipes());
        st.equipes.lidasEm = this.agora();
      }
    } catch (e) {
      await interromper(`Não deu para reconferir as equipes antes de entregar: ${msg(e)}`, 'aviso');
      return 0;
    }
    const comNativa = new Set(st.equipes.lista.filter((e) => e.distribuicaoNativa).map((e) => e.id));
    const cargaEspelho = async (userId) => (await this.cargaPorAtendente()).get(userId)?.total ?? 0;

    for (const d of decisoes) {
      const base = {
        modo: 'real', conversaId: d.conversaId, equipeId: d.equipeId, equipe: this.nomeEquipe(st, d.equipeId),
        userId: d.userId, atendente: this.nomeAtendente(st, d.userId), cargaAntes: d.cargaAntes,
      };
      const ignorar = (detalhe) => this.salvarDecisao({ ...base, em: this.agora(), resultado: 'ignorado', detalhe });
      if (this.agora() > fimLote) {
        await interromper('Lote chegou ao tempo máximo; o resto fica para o próximo ciclo.');
        break;
      }
      if (!pulse.podeChamarSemEsperar() || pulse.requisicoesRestantes() < CUSTO_POR_ATRIBUICAO) {
        await interromper('Sem orçamento de requisições para entregar agora; o resto fica para o próximo ciclo.', 'aviso');
        break;
      }
      if (comNativa.has(d.equipeId)) {
        await ignorar('A distribuição do próprio Pulse Direct foi religada nesta equipe.');
        continue;
      }
      try {
        if (this.agora() - st.atendentesLidosEm > RELER_ATENDENTES_MS) await this.lerAtendentes(st, pulse);
        const a = st.atendentes.find((x) => x.userId === d.userId);
        if (!a || !a.disponivel || !a.equipes.includes(d.equipeId)) {
          await ignorar('O atendente ficou offline ou saiu da equipe antes da entrega.');
          continue;
        }
        const atual = await pulse.obterConversa(d.conversaId);
        const conferidaEm = this.agora();
        if (!atual) {
          await this.estado.removerConversa(d.conversaId);
          await ignorar('A conversa não existe mais.');
          continue;
        }
        await this.estado.aplicarConversas([atual], { inicioDia });
        if (atual.userId || atual.status !== 'PENDING' || atual.equipeId !== d.equipeId) {
          await ignorar('A conversa mudou antes da entrega (ganhou dono, mudou de status ou de equipe).');
          continue;
        }
        const abertas = await pulse.contarAbertas(d.userId);
        this.corrigirCarga(st, d.userId, abertas, await cargaEspelho(d.userId));
        if (abertas >= st.config.teto) {
          await ignorar(`Na conferência o atendente já tinha ${abertas} abertas.`);
          continue;
        }
        // se a conferência demorou, a lista de atendentes pode ter envelhecido: relê antes de escrever
        if (this.agora() - st.atendentesLidosEm > RELER_ATENDENTES_MS) {
          await this.lerAtendentes(st, pulse);
          const ainda = st.atendentes.find((x) => x.userId === d.userId);
          if (!ainda || !ainda.disponivel || !ainda.equipes.includes(d.equipeId)) {
            await ignorar('O atendente ficou offline ou saiu da equipe antes da entrega.');
            continue;
          }
        }
        if (this.agora() - conferidaEm > CONFERENCIA_MAX_MS || !pulse.podeChamarSemEsperar()) {
          await ignorar('A conferência ficou velha antes da entrega (Pulse Direct lento ou limite de requisições).');
          await interromper('Conferência velha; o resto fica para o próximo ciclo.', 'aviso');
          break;
        }
        if (!(await this.estado.adquirirTrava('ciclo', dono, this.agora(), TRAVA_MS))) {
          await interromper('Outro ciclo assumiu a trava; parando as entregas.', 'aviso');
          break;
        }
        await pulse.atribuir(d.conversaId, d.userId);
        await this.estado.marcarAtribuida(d.conversaId, d.userId);
        this.corrigirCarga(st, d.userId, abertas + 1, await cargaEspelho(d.userId));
        await this.salvarDecisao({ ...base, cargaAntes: abertas, em: this.agora(), resultado: 'atribuido' });
        feitas++;
      } catch (e) {
        if (e instanceof AtribuicaoBloqueada) throw e;
        await this.salvarDecisao({ ...base, em: this.agora(), resultado: 'erro', detalhe: msg(e) });
        if (e instanceof ErroPulse && e.passageira) {
          await interromper(`Pulse Direct instável durante as entregas (${msg(e)}). O próximo ciclo reconfere tudo.`, 'aviso');
          break;
        }
        // recusa de regra do Pulse Direct (ex.: atendente sem acesso ao canal): não repete este par por 30 min
        st.bloqueios[`${d.conversaId}|${d.userId}`] = this.agora() + BLOQUEIO_MS;
      }
    }
    return feitas;
  }

  // ---------- gatilhos ----------

  /**
   * Evento de conversa do Pulse Direct (webhook). Garante um ciclo logo depois do evento, respeitando
   * o intervalo mínimo: só uma execução fica responsável por isso; as outras só anotam.
   */
  async aoEvento() {
    const agora = this.agora();
    await this.estado.gravarEstado({ gatilho_evento: agora }, agora);
    const { ciclo } = await this.estado.lerEstado(['ciclo']);
    const quando = Math.max(agora, (ciclo?.ultimoInicio ?? 0) + CICLO_MINIMO_MS);
    const dono = randomUUID();
    if (!(await this.estado.adquirirTrava('agenda', dono, agora, quando - agora + 20_000))) return { executado: false, motivo: 'agendado' };
    try {
      if (quando > agora) await this.dormir(Math.min(quando - agora, CICLO_MINIMO_MS));
      for (let tentativa = 0; tentativa < 3; tentativa++) {
        const r = await this.ciclo({ origem: 'evento', prazoMs: 14_000 });
        if (r.executado || r.motivo === 'recente') return r;
        await this.dormir(2_000); // outro ciclo em andamento: espera ele terminar
      }
      return { executado: false, motivo: 'em_andamento' };
    } finally {
      await this.estado.liberarTrava('agenda', dono);
    }
  }

  async aoAgendador() {
    await this.estado.gravarEstado({ gatilho_agendador: this.agora() }, this.agora());
    return this.ciclo({ origem: 'agendador', prazoMs: 22_000 });
  }

  // ---------- ações de administrador ----------

  async ligar(ligado, ator) {
    const config = await this.lerConfig();
    config.ligado = Boolean(ligado);
    await this.estado.gravarEstado({ config }, this.agora());
    if (config.ligado) await this.log.aviso('distribuicao_ligada', `${ator} LIGOU a distribuição automática: conversas passam a ser entregues de verdade nas equipes incluídas.`);
    else await this.log.info('distribuicao_desligada', `${ator} desligou a distribuição automática (volta a só simular).`);
    return config;
  }

  async salvarConfig(parcial, ator) {
    const config = await this.lerConfig();
    const inteiro = (v, min, max, nome) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`${nome}: use um número inteiro entre ${min} e ${max}.`), { status: 400 });
      return n;
    };
    if (parcial.teto !== undefined) config.teto = inteiro(parcial.teto, 1, 200, 'Teto por atendente');
    if (parcial.maxPorCiclo !== undefined) config.maxPorCiclo = inteiro(parcial.maxPorCiclo, 1, 50, 'Máximo por atendente a cada ciclo');
    if (parcial.alertaFilaMin !== undefined) config.alertaFilaMin = inteiro(parcial.alertaFilaMin, 1, 1440, 'Alerta de fila (min)');
    await this.estado.gravarEstado({ config }, this.agora());
    await this.log.info('configuracao', `${ator} alterou a configuração: teto ${config.teto}, até ${config.maxPorCiclo} por atendente a cada ciclo, alerta de fila em ${config.alertaFilaMin} min.`);
    return config;
  }

  async equipesAtuais(pulse) {
    const { equipes } = await this.estado.lerEstado(['equipes']);
    if (equipes?.lista?.length) return equipes.lista;
    return pulse.listarEquipes();
  }

  /** Configurar equipe: nome e distribuição do próprio Pulse Direct (escrevem no Pulse) e inclusão na distribuição automática (local). */
  async configurarEquipe(equipeId, { nome, distribuicaoNativa, incluir }, ator) {
    const pendentes = [];
    const pulse = await this.novoPulse(false, pendentes);
    try {
      const equipe = (await this.equipesAtuais(pulse)).find((e) => e.id === equipeId);
      if (!equipe) throw Object.assign(new Error('Equipe não encontrada no Pulse Direct.'), { status: 404 });
      const mudancas = {};
      if (typeof nome === 'string') {
        const limpo = nome.trim().slice(0, 80);
        if (!limpo) throw Object.assign(new Error('Informe o nome da equipe.'), { status: 400 });
        if (limpo !== equipe.nome) mudancas.nome = limpo;
      }
      if (typeof distribuicaoNativa === 'boolean' && distribuicaoNativa !== equipe.distribuicaoNativa) mudancas.distribuicaoNativa = distribuicaoNativa;
      if (Object.keys(mudancas).length) {
        await pulse.configurarEquipe(equipeId, mudancas);
        const partes = [];
        if (mudancas.nome) partes.push(`renomeou para "${mudancas.nome}"`);
        if ('distribuicaoNativa' in mudancas) partes.push(`${mudancas.distribuicaoNativa ? 'ligou' : 'desligou'} a distribuição do próprio Pulse Direct`);
        await this.log.info('gestao_equipe', `${ator} configurou a equipe ${equipe.nome}: ${partes.join(' e ')}.`, { equipeId });
      }
      if (typeof incluir === 'boolean') {
        const config = await this.lerConfig();
        const antes = Boolean(config.equipes[equipeId]);
        if (incluir) config.equipes[equipeId] = true;
        else delete config.equipes[equipeId];
        await this.estado.gravarEstado({ config }, this.agora());
        if (antes !== incluir) {
          await this.log.info('gestao_equipe', `${ator} ${incluir ? 'incluiu' : 'tirou'} a equipe ${mudancas.nome ?? equipe.nome} ${incluir ? 'na' : 'da'} distribuição automática.`, { equipeId });
        }
      }
      return mudancas;
    } finally {
      await Promise.allSettled(pendentes);
    }
  }

  /** Trocar de equipe, adicionar a outra equipe ou tirar da equipe (escreve no Pulse Direct). */
  async mudarEquipesDoAtendente(userId, { adicionar = [], remover = [] }, ator) {
    const pendentes = [];
    const pulse = await this.novoPulse(false, pendentes);
    try {
      const equipes = await this.equipesAtuais(pulse);
      const nomes = new Map(equipes.map((e) => [e.id, e.nome]));
      for (const id of [...adicionar, ...remover]) {
        if (!nomes.has(id)) throw Object.assign(new Error('Equipe não encontrada no Pulse Direct.'), { status: 400 });
      }
      if (adicionar.some((id) => remover.includes(id))) throw Object.assign(new Error('A mesma equipe está para adicionar e remover.'), { status: 400 });
      const { atendentes } = await this.estado.lerEstado(['atendentes']);
      const nome = (atendentes ?? []).find((a) => a.userId === userId)?.nome ?? 'o usuário';
      const feitas = [];
      const falhas = [];
      for (const id of remover) {
        try {
          await pulse.removerDaEquipe(id, userId);
          feitas.push(`tirou ${nome} de ${nomes.get(id)}`);
        } catch (e) {
          falhas.push(`${nomes.get(id)}: ${msg(e)}`);
        }
      }
      for (const id of adicionar) {
        try {
          await pulse.incluirNaEquipe(id, userId);
          feitas.push(`colocou ${nome} em ${nomes.get(id)}`);
        } catch (e) {
          falhas.push(`${nomes.get(id)}: ${msg(e)}`);
        }
      }
      if (feitas.length) await this.log.info('gestao_equipe', `${ator} ${feitas.join(' e ')}.`, { userId });
      if (falhas.length) await this.log.erro('gestao_equipe_falhou', `Falha ao mudar as equipes de ${nome}: ${falhas.join('; ')}`, { userId });
      return { feitas, falhas };
    } finally {
      await Promise.allSettled(pendentes);
    }
  }

  /** Cria (se ainda não existir) a assinatura de eventos de conversa no Pulse Direct apontando para este sistema. */
  async configurarEventos(urlEvento, ator) {
    const pendentes = [];
    const pulse = await this.novoPulse(false, pendentes);
    try {
      const existentes = await pulse.listarAssinaturas();
      const ja = existentes.find((s) => s?.url === urlEvento);
      if (ja) return { criada: false, ativa: ja.enabled !== false };
      await pulse.criarAssinatura(NOME_ASSINATURA, urlEvento);
      await this.log.info('gatilho_eventos', `${ator} ligou o gatilho por eventos do Pulse Direct (novas conversas, atualizações e encerramentos).`);
      return { criada: true, ativa: true };
    } finally {
      await Promise.allSettled(pendentes);
    }
  }

  // ---------- painel ----------

  async painel() {
    const st = await this.carregar();
    const agora = this.agora();
    const inicioDia = st.dia || inicioDoDia(agora, this.fuso);
    const [cargaPorAtendente, filaLinhas, concluidasLinhas, uso] = [
      await this.cargaPorAtendente(),
      await this.estado.fila(),
      await this.estado.concluidasHoje(inicioDia),
      await this.estado.usoRecente(agora - 300_000),
    ];
    const concluidas = new Map(concluidasLinhas.map((r) => [r.user_id, r.n]));
    const teto = st.config.teto;
    const atendentes = st.atendentes
      .filter((a) => a.equipes.length || cargaPorAtendente.has(a.userId) || concluidas.has(a.userId))
      .map((a) => {
        const c = cargaPorAtendente.get(a.userId) ?? { total: 0, pendentes: 0, emAtendimento: 0, porEquipe: {} };
        return {
          userId: a.userId,
          nome: a.nome,
          email: a.email,
          online: a.disponivel,
          equipes: a.equipes.map((id) => ({ id, nome: this.nomeEquipe(st, id) })),
          abertas: c.total,
          pendentes: c.pendentes,
          emAtendimento: c.emAtendimento,
          porEquipe: Object.entries(c.porEquipe)
            .map(([id, n]) => ({ id: id || null, nome: this.nomeEquipe(st, id || null), n, membro: a.equipes.includes(id) }))
            .sort((x, y) => y.n - x.n),
          vagas: Math.max(0, teto - c.total),
          concluidasHoje: concluidas.get(a.userId) ?? 0,
        };
      });
    const fila = filaLinhas.map((r) => ({ equipeId: r.equipe_id, criadaEm: r.criada_em }));
    const limiteAlerta = st.config.alertaFilaMin * 60_000;
    const gerenciadas = new Set(st.gerenciadas);
    const equipes = st.equipes.lista.map((e) => {
      const membros = st.atendentes.filter((a) => a.equipes.includes(e.id));
      const online = membros.filter((a) => a.disponivel);
      const daEquipe = fila.filter((c) => c.equipeId === e.id);
      const maisAntiga = daEquipe.reduce((m, c) => (c.criadaEm && (m === null || c.criadaEm < m) ? c.criadaEm : m), null);
      const incluida = Boolean(st.config.equipes[e.id]);
      const quem = !membros.length ? 'ninguem' : e.distribuicaoNativa ? 'pulse' : incluida ? 'sistema' : 'manual';
      const semVaga = st.semVaga[e.id] ?? 0;
      let alerta = null;
      if (daEquipe.length && membros.length) {
        if (!online.length) alerta = 'Ninguém online';
        else if (incluida && semVaga) alerta = `${semVaga} sem vaga agora`;
        else if (maisAntiga !== null && agora - maisAntiga >= limiteAlerta) alerta = 'Esperando demais';
      }
      return {
        id: e.id, nome: e.nome, distribuicaoNativa: e.distribuicaoNativa, incluida, gerenciada: gerenciadas.has(e.id), quemDistribui: quem,
        aguardando: daEquipe.length, maisAntigaEm: maisAntiga, atendentes: membros.length, online: online.length,
        vagasLivres: online.reduce((s, a) => s + Math.max(0, teto - (cargaPorAtendente.get(a.userId)?.total ?? 0)), 0),
        semVaga, alerta,
      };
    });
    const emEquipe = st.atendentes.filter((a) => a.equipes.length);
    const online = emEquipe.filter((a) => a.disponivel);
    return {
      ligado: st.config.ligado,
      config: { teto, maxPorCiclo: st.config.maxPorCiclo, alertaFilaMin: st.config.alertaFilaMin },
      ultimoCicloEm: st.ciclo.ultimoInicio || null,
      ultimoCicloOkEm: st.ciclo.ultimoOk || null,
      ultimaDuracaoMs: st.ciclo.ultimaDuracao,
      erros: st.erros,
      requisicoes5min: uso,
      orcamento5min: this.orcamento5min,
      concluidasCarregadas: Boolean(st.concluidas.carregadas),
      leituraCompleta: Boolean(st.reconciliacao.ultimaEm),
      gatilhos: st.gatilhos,
      avisos: st.avisos.map((a) => a.texto),
      resumo: {
        atendentesEmEquipe: emEquipe.length,
        online: online.length,
        abertasComAtendentes: [...cargaPorAtendente.values()].reduce((s, c) => s + c.total, 0),
        naFila: equipes.filter((e) => e.quemDistribui !== 'ninguem').reduce((s, e) => s + e.aguardando, 0),
        concluidasHoje: [...concluidas.values()].reduce((s, n) => s + n, 0),
        onlineAcimaDoTeto: online.filter((a) => (cargaPorAtendente.get(a.userId)?.total ?? 0) > teto).length,
        vagasLivresOnline: online.reduce((s, a) => s + Math.max(0, teto - (cargaPorAtendente.get(a.userId)?.total ?? 0)), 0),
        equipesIncluidas: equipes.filter((e) => e.incluida).length,
      },
      atendentes,
      equipes,
    };
  }
}
