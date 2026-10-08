// Log estruturado da distribuição: uma linha JSON por evento no stdout (logs da Vercel) e,
// para o que importa à operação, também no banco (aba Registro do painel).
export class Registro {
  constructor(estado, { saida, agora } = {}) {
    this.estado = estado;
    this.saida = saida ?? ((linha) => process.stdout.write(`${linha}\n`));
    this.agora = agora ?? Date.now;
  }

  async registrar(nivel, tipo, mensagem, dados, persistir = true) {
    const em = this.agora();
    this.saida(JSON.stringify({ em: new Date(em).toISOString(), origem: 'distribuicao', nivel, tipo, mensagem, ...(dados ? { dados } : {}) }));
    if (!persistir || !this.estado) return;
    try {
      await this.estado.registrarEvento({ em, nivel, tipo, mensagem, dados: dados ?? null });
    } catch (e) {
      this.saida(JSON.stringify({ em: new Date(em).toISOString(), origem: 'distribuicao', nivel: 'erro', tipo: 'registro_falhou', mensagem: String(e?.message ?? e) }));
    }
  }

  info(tipo, mensagem, dados) { return this.registrar('info', tipo, mensagem, dados); }
  aviso(tipo, mensagem, dados) { return this.registrar('aviso', tipo, mensagem, dados); }
  erro(tipo, mensagem, dados) { return this.registrar('erro', tipo, mensagem, dados); }

  /** Só stdout: alto volume (cada ciclo, cada decisão simulada, chamadas com erro). */
  trilha(tipo, mensagem, dados, nivel = 'info') { return this.registrar(nivel, tipo, mensagem, dados, false); }
}
