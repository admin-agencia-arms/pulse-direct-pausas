/**
 * Pulse Direct falso por HTTP, para os testes. Imita os endpoints usados (bases /core e /chat,
 * filtros, paginação de 100, datas em µs com formatos variados, 429/5xx sob demanda) e FISCALIZA
 * cada atribuição: conversa já com dono, atendente fora da equipe, offline ou no teto viram "violações".
 */
import { createServer } from 'node:http';

const ABERTOS = ['STARTED', 'PENDING', 'IN_PROGRESS'];
export const TEXTO_SENSIVEL = 'CONTEUDO-SENSIVEL-DO-CLIENTE';

export class PulseFalso {
  constructor() {
    this.token = 'token-de-teste';
    this.teto = 15;
    this.agentes = new Map(); // userId → { userId, nome, email, disponivel, equipes: [] }
    this.equipes = new Map(); // id → { id, nome, distribuicao }
    this.conversas = new Map();
    this.assinaturas = [];
    this.pedidos = [];
    this.puts = [];
    this.violacoes = [];
    this.falhar429 = 0;
    this.falhar500 = 0;
    this.falhar429NoPut = 0;
    /** Somado ao total informado nas contagens (simula conversa que a leitura não alcança). */
    this.desvioTotal = 0;
    this.aoObterConversa = null;
    this.servidor = null;
    this.seq = 0;
    this.relogio = Date.now();
  }

  agora() {
    this.relogio = Math.max(this.relogio + 1, Date.now());
    return this.relogio;
  }

  equipe(id, nome = `Equipe ${id}`, distribuicao = false) {
    this.equipes.set(id, { id, nome, distribuicao });
  }

  agente(userId, equipes, disponivel = true, nome = `Atendente ${userId}`) {
    this.agentes.set(userId, { userId, nome, email: `${userId}@teste.com`, disponivel, equipes: [...equipes] });
  }

  novaConversa(campos = {}) {
    const t = this.agora();
    const c = {
      id: `c${String(++this.seq).padStart(6, '0')}-0000-4000-8000-000000000000`,
      status: 'PENDING', departmentId: null, userId: null, createdAt: t, updatedAt: t, endAt: null, type: 'INDIVIDUAL', ...campos,
    };
    this.conversas.set(c.id, c);
    return c;
  }

  mudar(c, campos) {
    Object.assign(c, campos, { updatedAt: this.agora() });
  }

  abertasDe(userId) {
    let n = 0;
    for (const c of this.conversas.values()) if (c.userId === userId && ABERTOS.includes(c.status)) n++;
    return n;
  }

  /** Datas como as do Pulse Direct: guarda ms e mostra com µs (às vezes com Z e 7 casas, às vezes sem Z e 8). */
  data(ms) {
    if (ms === null || ms === undefined) return null;
    const base = new Date(ms).toISOString().slice(0, 23);
    return ms % 2 ? `${base}4567Z` : `${base}45678`;
  }

  dto(c) {
    return {
      id: c.id, status: c.status, departmentId: c.departmentId, userId: c.userId,
      createdAt: this.data(c.createdAt), updatedAt: this.data(c.updatedAt), endAt: this.data(c.endAt), startAt: this.data(c.createdAt),
      type: c.type, number: null, botId: 'bot-qualquer', lastMessageText: TEXTO_SENSIVEL,
      contactDetails: { name: TEXTO_SENSIVEL, phonenumber: '+55|31999999999' },
    };
  }

  listar(q) {
    const status = q.getAll('Status');
    const num = (k) => (q.get(k) ? Date.parse(q.get(k)) : null);
    const userId = q.get('UserId');
    const atualizadaApos = num('UpdatedAt.After'), terminadaApos = num('EndAt.After');
    let itens = [...this.conversas.values()].filter((c) =>
      (!status.length || status.includes(c.status))
      && (!userId || c.userId === userId)
      // guarda µs (o ".4567"): "depois de X.151" ainda inclui X.151xxx, como o Pulse Direct
      && (atualizadaApos === null || c.updatedAt + 0.5 > atualizadaApos)
      && (terminadaApos === null || (c.endAt ?? 0) > terminadaApos));
    const campo = q.get('OrderBy') === 'UpdatedAt' ? 'updatedAt' : 'createdAt';
    itens.sort((a, b) => a[campo] - b[campo] || a.id.localeCompare(b.id));
    const tamanho = Math.min(100, Math.max(1, Number(q.get('PageSize') ?? 15)));
    const pagina = Math.max(1, Number(q.get('PageNumber') ?? 1));
    const total = itens.length + (tamanho === 1 ? this.desvioTotal : 0);
    const paginas = Math.ceil(total / tamanho);
    itens = itens.slice((pagina - 1) * tamanho, pagina * tamanho);
    return { pageNumber: pagina, pageSize: tamanho, totalItems: total, totalPages: paginas, hasMorePages: pagina < paginas, items: itens.map((c) => this.dto(c)) };
  }

  atribuir(conversaId, userId) {
    const c = this.conversas.get(conversaId);
    const a = this.agentes.get(userId);
    this.puts.push({ conversaId, userId });
    if (!c) return [404, { error: true, text: 'Conversa não encontrada' }];
    if (c.userId) this.violacoes.push(`conversa ${conversaId} já tinha dono (${c.userId}) e foi dada a ${userId}`);
    if (c.status !== 'PENDING') this.violacoes.push(`conversa ${conversaId} não estava pendente (${c.status})`);
    if (!a) this.violacoes.push(`atendente inexistente ${userId}`);
    else {
      if (!a.disponivel) this.violacoes.push(`${a.nome} estava offline`);
      if (!c.departmentId || !a.equipes.includes(c.departmentId)) this.violacoes.push(`${a.nome} não é da equipe ${c.departmentId}`);
    }
    const abertas = this.abertasDe(userId);
    if (abertas >= this.teto) this.violacoes.push(`${a?.nome ?? userId} já tinha ${abertas} abertas (teto ${this.teto})`);
    this.mudar(c, { userId });
    return [200, this.dto(c)];
  }

  async corpo(req) {
    const partes = [];
    for await (const p of req) partes.push(p);
    const texto = Buffer.concat(partes).toString();
    return texto ? JSON.parse(texto) : null;
  }

  async iniciar() {
    this.servidor = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const p = url.pathname;
      const responder = (status, corpo) => {
        this.pedidos.push({ metodo: req.method, caminho: p, status });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.authorization !== `Bearer ${this.token}`) return responder(401, { error: true });
      if (this.falhar429 > 0) { this.falhar429--; return responder(429, { error: true }); }
      if (this.falhar500 > 0) { this.falhar500--; return responder(500, { error: true }); }
      const agentesDto = () => [...this.agentes.values()].map((a) => ({
        id: `ag-${a.userId}`, userId: a.userId, name: a.nome, email: a.email, profile: 'AGENT',
        availability: a.disponivel ? 'AVAILABLE' : 'UNAVAILABLE',
        departments: a.equipes.map((d) => ({ departmentId: d, isAgent: true, isSupervisor: false })),
      }));
      if (req.method === 'GET' && p === '/core/v1/agent') return responder(200, agentesDto());
      if (req.method === 'GET' && p === '/core/v2/department') {
        return responder(200, [...this.equipes.values()].map((e) => ({
          id: e.id, name: e.nome, distribuitionEnabled: e.distribuicao,
          agents: [...this.agentes.values()].filter((a) => a.equipes.includes(e.id)).map((a) => ({ userId: a.userId, isAgent: true, isSupervisor: false })),
        })));
      }
      const agentePut = /^\/core\/v1\/agent\/([^/]+)$/.exec(p);
      if (req.method === 'PUT' && agentePut) {
        const corpo = await this.corpo(req);
        const a = this.agentes.get(agentePut[1]);
        if (!a) return responder(404, { error: true, key: 'ENTITY_NOT_FOUND', text: 'Usuário não encontrado' });
        if (corpo?.fields?.includes('Availability')) a.disponivel = corpo.availability === 'AVAILABLE';
        return responder(200, agentesDto().find((x) => x.userId === a.userId));
      }
      const equipeAgentes = /^\/core\/v1\/department\/([^/]+)\/agents$/.exec(p);
      if (req.method === 'PUT' && equipeAgentes) {
        const corpo = await this.corpo(req);
        if (!this.equipes.has(equipeAgentes[1])) return responder(404, { error: true, text: 'Equipe não encontrada' });
        for (const it of corpo.items ?? []) {
          const a = this.agentes.get(it.userId);
          if (!a) continue;
          if (corpo.action === 'Upsert' && !a.equipes.includes(equipeAgentes[1])) a.equipes.push(equipeAgentes[1]);
          if (corpo.action === 'Remove') a.equipes = a.equipes.filter((x) => x !== equipeAgentes[1]);
        }
        return responder(200, corpo);
      }
      const equipe = /^\/core\/v1\/department\/([^/]+)$/.exec(p);
      if (req.method === 'PUT' && equipe) {
        const corpo = await this.corpo(req);
        const e = this.equipes.get(equipe[1]);
        if (!e) return responder(404, { error: true, text: 'Equipe não encontrada' });
        if (corpo.fields?.includes('Name')) e.nome = corpo.name;
        if (corpo.fields?.includes('DistributionIsEnabled')) e.distribuicao = corpo.distributionIsEnabled;
        return responder(200, { id: e.id, name: e.nome, distribuitionEnabled: e.distribuicao });
      }
      if (p === '/core/v1/webhook/subscription') {
        if (req.method === 'GET') return responder(200, this.assinaturas);
        if (req.method === 'POST') {
          const corpo = await this.corpo(req);
          const s = { id: `s${this.assinaturas.length + 1}`, name: corpo.name, url: corpo.url, enabled: corpo.enabled, events: corpo.events.map((event) => ({ event })) };
          this.assinaturas.push(s);
          return responder(200, s);
        }
      }
      if (req.method === 'GET' && p === '/chat/v2/session') return responder(200, this.listar(url.searchParams));
      const porId = /^\/chat\/v2\/session\/([^/]+)$/.exec(p);
      if (req.method === 'GET' && porId) {
        const c = this.conversas.get(porId[1]);
        if (c) this.aoObterConversa?.(c);
        return c ? responder(200, this.dto(c)) : responder(404, { error: true });
      }
      const atribuicao = /^\/chat\/v1\/session\/([^/]+)\/assignee$/.exec(p);
      if (req.method === 'PUT' && atribuicao) {
        if (this.falhar429NoPut > 0) { this.falhar429NoPut--; return responder(429, { error: true }); }
        const corpo = await this.corpo(req);
        const [status, r] = this.atribuir(atribuicao[1], corpo?.userId);
        return responder(status, r);
      }
      responder(404, { error: true, text: `rota falsa inexistente: ${req.method} ${p}` });
    });
    await new Promise((r) => this.servidor.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${this.servidor.address().port}`;
  }

  async parar() {
    if (!this.servidor) return;
    this.servidor.closeAllConnections();
    await new Promise((r) => this.servidor.close(r));
  }
}
