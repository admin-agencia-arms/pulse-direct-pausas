// Cliente da API do Pulse Direct para a distribuição automática. O token fica só no servidor.
// - Toda chamada passa pelo Limitador (orçamento próprio, abaixo do limite da conta).
// - Atribuir conversa só sai com permitirAtribuir=true (distribuição ligada) e NUNCA é repetida:
//   depois de 429, queda de rede ou tempo esgotado o resultado é incerto e o próximo ciclo reconfere.
// - Listas são paginadas pela data de alteração (cursor em µs), não por número de página:
//   conversa que muda durante a leitura não desloca as páginas, então nada fica para trás.
import { isoMicros, lerData, lerMicros } from './datas.js';

const STATUS_ABERTOS = ['STARTED', 'PENDING', 'IN_PROGRESS'];
const EVENTOS_CONVERSA = ['SESSION_NEW', 'SESSION_UPDATE', 'SESSION_COMPLETE'];

export class ErroPulse extends Error {
  /** status HTTP; 0 = falha de rede ou tempo esgotado */
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }

  /** Falha passageira (limite, rede, servidor): vale esperar e tentar no próximo ciclo. */
  get passageira() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export class AtribuicaoBloqueada extends Error {
  constructor() {
    super('Atribuição bloqueada: a distribuição automática está desligada.');
  }
}

/** Janela deslizante de 5 min + intervalo mínimo entre chamadas + pausa ao levar 429. */
export class Limitador {
  constructor(orcamento5min, intervaloMinMs = 250, agora = Date.now, dormir = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.chamadas = [];
    this.ultima = Number.NEGATIVE_INFINITY;
    this.pausadoAte = 0;
    this.orcamento = orcamento5min;
    this.intervaloMinMs = intervaloMinMs;
    this.agora = agora;
    this.dormir = dormir;
  }

  /** Chamadas feitas por outras execuções (serverless) também contam na janela. */
  semear(instantes) {
    const t = this.agora();
    this.chamadas = [...instantes.filter((x) => x > t - 300_000), ...this.chamadas].sort((a, b) => a - b);
  }

  limpar(t) {
    while (this.chamadas.length && this.chamadas[0] <= t - 300_000) this.chamadas.shift();
  }

  uso() {
    this.limpar(this.agora());
    return this.chamadas.length;
  }

  restante() {
    return Math.max(0, this.orcamento - this.uso());
  }

  livre() {
    return this.restante() > 0 && this.agora() >= this.pausadoAte;
  }

  pausar(ms) {
    this.pausadoAte = Math.max(this.pausadoAte, this.agora() + ms);
  }

  async aguardarVez() {
    for (;;) {
      const t = this.agora();
      this.limpar(t);
      let espera = Math.max(0, this.pausadoAte - t, this.ultima + this.intervaloMinMs - t);
      if (this.chamadas.length >= this.orcamento) espera = Math.max(espera, this.chamadas[0] + 300_000 - t);
      if (espera <= 0) break;
      await this.dormir(Math.min(espera, 5_000));
    }
    const t = this.agora();
    this.ultima = t;
    this.chamadas.push(t);
  }
}

function conversa(c) {
  return {
    id: c.id,
    status: c.status,
    equipeId: c.departmentId ?? null,
    userId: c.userId ?? null,
    criadaEm: lerData(c.createdAt),
    alteradaUs: lerMicros(c.updatedAt),
    encerradaEm: lerData(c.endAt),
    tipo: c.type ?? null,
  };
}

/** Endereços da API: PULSE_API_URL é a base "core"; a de conversas ("chat") vem de PULSE_CHAT_API_URL ou é derivada dela. */
export function enderecosPulse(env = process.env) {
  const core = (env.PULSE_API_URL || '').replace(/\/+$/, '');
  const chat = (env.PULSE_CHAT_API_URL || '').replace(/\/+$/, '') || (/\/core$/.test(core) ? core.replace(/\/core$/, '/chat') : '');
  return { core, chat };
}

export class ClientePulse {
  constructor({ token, core, chat, limitador, permitirAtribuir = false, fetch: f, aoChamar, aoLimite, timeoutMs = 20_000 }) {
    this.token = token;
    this.bases = { core, chat };
    this.limitador = limitador;
    this.permitirAtribuir = permitirAtribuir;
    this.fetch = f ?? fetch;
    this.aoChamar = aoChamar ?? (() => {});
    this.aoLimite = aoLimite ?? (() => {});
    this.timeoutMs = timeoutMs;
    this.total = 0;
    this.relogio = null;
  }

  usoUltimos5min() { return this.limitador.uso(); }
  requisicoesRestantes() { return this.limitador.restante(); }
  podeChamarSemEsperar() { return this.limitador.livre(); }
  totalRequisicoes() { return this.total; }

  /** Hora do Pulse Direct (cabeçalho Date da última resposta), ou a local se ainda não houver. */
  relogioPulse() {
    const agora = Date.now();
    return this.relogio ? this.relogio.pulse + (agora - this.relogio.local) : agora;
  }

  async chamar(metodo, base, caminho, query = [], corpo) {
    const raiz = this.bases[base];
    if (!raiz || !this.token) throw new ErroPulse(500, 'Integração com o Pulse Direct não configurada (PULSE_API_URL / PULSE_API_TOKEN).');
    const leitura = metodo === 'GET';
    const qs = new URLSearchParams(query).toString();
    const url = `${raiz}${caminho}${qs ? `?${qs}` : ''}`;
    const caminhoLog = `/${base}${caminho}${qs ? `?${qs}` : ''}`.replace(/([?&])_=\d+/, '$1_=…');
    let ultimoErro;
    // leitura tenta até 4 vezes; escrita, uma só (repetir poderia, por ex., entregar uma conversa que mudou de dono)
    for (let tentativa = 1; tentativa <= (leitura ? 4 : 1); tentativa++) {
      await this.limitador.aguardarVez();
      this.total++;
      const t0 = Date.now();
      let resp;
      try {
        resp = await this.fetch(url, {
          method: metodo,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: corpo === undefined ? undefined : JSON.stringify(corpo),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        this.notificar({ metodo, caminho: caminhoLog, status: 0, duracaoMs: Date.now() - t0, tentativa });
        const motivo = e instanceof Error ? e.message : String(e);
        ultimoErro = new ErroPulse(0, leitura
          ? `Falha de rede em ${metodo} ${caminho}: ${motivo}`
          : `Falha de rede em ${metodo} ${caminho} (resultado incerto, será reconferido): ${motivo}`);
        continue;
      }
      this.notificar({ metodo, caminho: caminhoLog, status: resp.status, duracaoMs: Date.now() - t0, tentativa });
      const data = Date.parse(resp.headers.get('date') ?? '');
      if (!Number.isNaN(data)) this.relogio = { pulse: data, local: Date.now() };
      if (resp.status === 429) {
        const pausa = 5_000 * tentativa;
        this.limitador.pausar(pausa);
        this.aoLimite(pausa);
        ultimoErro = new ErroPulse(429, `Limite de requisições do Pulse Direct atingido em ${metodo} ${caminho}`);
        continue;
      }
      if (resp.status >= 500 && leitura) {
        ultimoErro = new ErroPulse(resp.status, `Pulse Direct respondeu ${resp.status} em ${caminho}`);
        continue;
      }
      const texto = await resp.text();
      if (resp.status === 401 || resp.status === 403) {
        throw new ErroPulse(resp.status, `O Pulse Direct recusou o token (${resp.status}). Confira PULSE_API_TOKEN.`);
      }
      let json = null;
      try { json = texto ? JSON.parse(texto) : null; } catch { /* abaixo */ }
      // corpo que não é JSON (página de erro de proxy, por ex.) não vai para a tela nem para o registro
      if (!resp.ok || json?.error === true) {
        throw new ErroPulse(resp.status >= 400 ? resp.status : 400, json?.text || `Pulse Direct respondeu ${resp.status} em ${metodo} ${caminho}`);
      }
      if (texto && json === null) throw new ErroPulse(502, `Resposta inesperada do Pulse Direct (não é JSON) em ${caminho}`);
      return json;
    }
    throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro));
  }

  notificar(c) {
    try { this.aoChamar(c); } catch { /* log nunca derruba a chamada */ }
  }

  // ---------- leitura ----------

  async listarAtendentes() {
    const lista = await this.chamar('GET', 'core', '/v1/agent');
    return (lista ?? []).map((a) => ({
      userId: a.userId,
      nome: a.name ?? a.shortName ?? a.email ?? a.userId,
      email: a.email ?? null,
      disponivel: a.availability === 'AVAILABLE',
      equipes: (a.departments ?? []).filter((d) => d.isAgent).map((d) => d.departmentId),
    }));
  }

  async listarEquipes() {
    const lista = await this.chamar('GET', 'core', '/v2/department');
    return (lista ?? []).map((d) => ({
      id: d.id,
      nome: d.name ?? d.id,
      // a API escreve "distribuitionEnabled" (sic)
      distribuicaoNativa: Boolean(d.distribuitionEnabled ?? d.distributionEnabled),
    }));
  }

  /**
   * Conversas alteradas depois de `desde` (ms, ou um cursor {desdeUs, pagina} de uma leitura anterior),
   * em ordem de alteração, até maxPaginas páginas de 100. Devolve {conversas, ultimo (ms), completo, cursor}.
   */
  async listarAtualizadas(filtros, desde, maxPaginas) {
    let cursor = typeof desde === 'number' ? { desdeUs: Math.floor(desde) * 1000, pagina: 1 } : { ...desde };
    const vistas = new Map();
    let maiorUs = null;
    let completo = false;
    for (let i = 0; i < maxPaginas; i++) {
      const r = await this.chamar('GET', 'chat', '/v2/session', [
        ...filtros, ['UpdatedAt.After', isoMicros(cursor.desdeUs)],
        ['OrderBy', 'UpdatedAt'], ['OrderDirection', 'ASCENDING'], ['PageSize', '100'],
        ...(cursor.pagina > 1 ? [['PageNumber', String(cursor.pagina)]] : []),
      ]);
      const itens = (r?.items ?? []).map(conversa);
      let fimPagina = null;
      for (const c of itens) {
        vistas.set(c.id, c);
        if (c.alteradaUs !== null && (fimPagina === null || c.alteradaUs > fimPagina)) fimPagina = c.alteradaUs;
      }
      if (fimPagina !== null && (maiorUs === null || fimPagina > maiorUs)) maiorUs = fimPagina;
      if (itens.length < 100) {
        completo = true;
        break;
      }
      // Continua 1 µs antes do último lido: relê o empate do fim (inofensivo, há deduplicação) e não
      // pula nada. Se a página inteira for um empate só (alteração em massa no mesmo instante), ou
      // não tiver data legível, segue por número de página dentro do mesmo "depois de".
      cursor = fimPagina !== null && fimPagina - 1 > cursor.desdeUs
        ? { desdeUs: fimPagina - 1, pagina: 1 }
        : { desdeUs: cursor.desdeUs, pagina: cursor.pagina + 1 };
    }
    return { conversas: [...vistas.values()], ultimo: maiorUs === null ? null : Math.floor(maiorUs / 1000), completo, cursor };
  }

  /** Total de conversas que atendem aos filtros (uma requisição, pelo totalItems). */
  async contarConversas(filtros) {
    const r = await this.chamar('GET', 'chat', '/v2/session', [...filtros, ['PageSize', '1'], ['_', String(Date.now())]]);
    const total = r?.totalItems;
    // na dúvida, não entrega: contagem esquisita nunca vira "zero"
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
      throw new ErroPulse(502, `Contagem inválida do Pulse Direct: ${JSON.stringify(total)}`);
    }
    return total;
  }

  contarAbertas(userId) {
    return this.contarConversas([['UserId', userId], ...STATUS_ABERTOS.map((s) => ['Status', s])]);
  }

  async obterConversa(id) {
    try {
      // parâmetro "_" evita resposta de cache intermediário
      return conversa(await this.chamar('GET', 'chat', `/v2/session/${encodeURIComponent(id)}`, [['_', String(Date.now())]]));
    } catch (e) {
      if (e instanceof ErroPulse && e.status === 404) return null;
      throw e;
    }
  }

  // ---------- escrita da distribuição ----------

  async atribuir(conversaId, userId) {
    if (!this.permitirAtribuir) throw new AtribuicaoBloqueada();
    const r = await this.chamar('PUT', 'chat', `/v1/session/${encodeURIComponent(conversaId)}/assignee`, [], { userId });
    return r?.id ? conversa(r) : null;
  }

  // ---------- gestão de equipe (ações explícitas de administrador) ----------

  incluirNaEquipe(equipeId, userId) {
    return this.chamar('PUT', 'core', `/v1/department/${encodeURIComponent(equipeId)}/agents`, [],
      { action: 'Upsert', items: [{ userId, isAgent: true, isSupervisor: false }] });
  }

  removerDaEquipe(equipeId, userId) {
    return this.chamar('PUT', 'core', `/v1/department/${encodeURIComponent(equipeId)}/agents`, [],
      { action: 'Remove', items: [{ userId, isAgent: true, isSupervisor: false }] });
  }

  configurarEquipe(equipeId, { nome, distribuicaoNativa }) {
    const corpo = { fields: [] };
    if (typeof nome === 'string') { corpo.name = nome; corpo.fields.push('Name'); }
    if (typeof distribuicaoNativa === 'boolean') { corpo.distributionIsEnabled = distribuicaoNativa; corpo.fields.push('DistributionIsEnabled'); }
    if (!corpo.fields.length) return Promise.resolve(null);
    return this.chamar('PUT', 'core', `/v1/department/${encodeURIComponent(equipeId)}`, [], corpo);
  }

  // ---------- gatilho por eventos ----------

  async listarAssinaturas() {
    const r = await this.chamar('GET', 'core', '/v1/webhook/subscription');
    return Array.isArray(r) ? r : (r?.items ?? []);
  }

  criarAssinatura(nome, url) {
    return this.chamar('POST', 'core', '/v1/webhook/subscription', [], { name: nome, url, enabled: true, events: EVENTOS_CONVERSA });
  }
}
