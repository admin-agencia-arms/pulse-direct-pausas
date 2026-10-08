/**
 * Regra de distribuição (função pura, sem rede nem banco):
 * conversa mais antiga da fila → atendente ONLINE daquela equipe com MAIS vagas
 * (menos conversas abertas). Empate → quem recebeu há mais tempo.
 * Quem está em várias equipes tem um teto só, somando tudo.
 *
 * entrada: { fila: [{id, equipeId, criadaEm}], atendentes: [{userId, nome, online, equipes: Set}],
 *            carga: Map(userId→n), ultimaEntrega: Map(userId→ms), equipesGerenciadas: Set,
 *            teto, maxPorAtendente, maxTotal, bloqueado?(conversaId, userId) }
 * saída: { decisoes: [{conversaId, equipeId, userId, cargaAntes}], semVaga: Map(equipeId→n) }
 */
export function alocar(e) {
  const carga = new Map(e.carga);
  const recebidas = new Map();
  const decisoes = [];
  const semVaga = new Map();

  const fila = e.fila
    .filter((c) => e.equipesGerenciadas.has(c.equipeId))
    .sort((a, b) => a.criadaEm - b.criadaEm || a.id.localeCompare(b.id));

  for (const item of fila) {
    if (decisoes.length >= e.maxTotal) break;
    let escolhido = null;
    for (const a of e.atendentes) {
      if (!a.online || !a.equipes.has(item.equipeId)) continue;
      if ((carga.get(a.userId) ?? 0) >= e.teto) continue;
      if ((recebidas.get(a.userId) ?? 0) >= e.maxPorAtendente) continue;
      if (e.bloqueado?.(item.id, a.userId)) continue;
      if (!escolhido || melhor(a, escolhido, carga, e.ultimaEntrega)) escolhido = a;
    }
    if (!escolhido) {
      semVaga.set(item.equipeId, (semVaga.get(item.equipeId) ?? 0) + 1);
      continue;
    }
    const antes = carga.get(escolhido.userId) ?? 0;
    decisoes.push({ conversaId: item.id, equipeId: item.equipeId, userId: escolhido.userId, cargaAntes: antes });
    carga.set(escolhido.userId, antes + 1);
    recebidas.set(escolhido.userId, (recebidas.get(escolhido.userId) ?? 0) + 1);
  }
  return { decisoes, semVaga };
}

function melhor(a, b, carga, ultima) {
  const ca = carga.get(a.userId) ?? 0, cb = carga.get(b.userId) ?? 0;
  if (ca !== cb) return ca < cb;
  const ua = ultima.get(a.userId) ?? 0, ub = ultima.get(b.userId) ?? 0;
  if (ua !== ub) return ua < ub;
  return a.nome.localeCompare(b.nome) < 0;
}
