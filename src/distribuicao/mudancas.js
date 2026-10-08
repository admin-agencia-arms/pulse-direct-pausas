/**
 * Compara duas leituras do Pulse Direct e descreve o que mudou. É o que mostra a
 * auto-manutenção funcionando: o sistema não guarda cadastro próprio, só percebe
 * e registra o que o Pulse Direct passou a dizer.
 */

export const resumirEquipes = (l) => l.map((e) => ({ id: e.id, nome: e.nome, distribuicaoNativa: e.distribuicaoNativa }));

export const resumirAtendentes = (l) =>
  l.map((a) => ({ userId: a.userId, nome: a.nome, disponivel: a.disponivel, equipes: [...a.equipes].sort() }));

export function mudancasEquipes(antes, depois) {
  const r = [];
  const mapaAntes = new Map(antes.map((e) => [e.id, e]));
  const mapaDepois = new Map(depois.map((e) => [e.id, e]));
  for (const e of depois) {
    const a = mapaAntes.get(e.id);
    if (!a) {
      r.push({ nivel: 'info', tipo: 'equipe_criada', mensagem: `Equipe criada: ${e.nome}`, dados: { equipeId: e.id } });
      continue;
    }
    if (a.nome !== e.nome) {
      r.push({ nivel: 'info', tipo: 'equipe_renomeada', mensagem: `Equipe renomeada: ${a.nome} → ${e.nome}`, dados: { equipeId: e.id } });
    }
    if (a.distribuicaoNativa !== e.distribuicaoNativa) {
      r.push({
        nivel: 'aviso', tipo: 'equipe_distribuicao_nativa',
        mensagem: `${e.nome}: distribuição automática do Pulse Direct foi ${e.distribuicaoNativa ? 'LIGADA' : 'desligada'}`,
        dados: { equipeId: e.id, ligada: e.distribuicaoNativa },
      });
    }
  }
  for (const a of antes) {
    if (!mapaDepois.has(a.id)) r.push({ nivel: 'aviso', tipo: 'equipe_removida', mensagem: `Equipe removida: ${a.nome}`, dados: { equipeId: a.id } });
  }
  return r;
}

export function mudancasAtendentes(antes, depois, nomeEquipe, { disponibilidade }) {
  const r = [];
  const mapaAntes = new Map(antes.map((a) => [a.userId, a]));
  const mapaDepois = new Map(depois.map((a) => [a.userId, a]));
  for (const a of depois) {
    const b = mapaAntes.get(a.userId);
    if (!b) {
      const equipes = a.equipes.map(nomeEquipe);
      r.push({
        nivel: 'info', tipo: 'atendente_novo',
        mensagem: `Novo usuário no Pulse Direct: ${a.nome}${equipes.length ? ` (atende ${equipes.join(', ')})` : ''}`,
        dados: { userId: a.userId },
      });
      continue;
    }
    if (b.nome !== a.nome) {
      r.push({ nivel: 'info', tipo: 'atendente_renomeado', mensagem: `${b.nome} agora se chama ${a.nome}`, dados: { userId: a.userId } });
    }
    if (disponibilidade && b.disponivel !== a.disponivel) {
      r.push({
        nivel: 'info', tipo: a.disponivel ? 'atendente_online' : 'atendente_offline',
        mensagem: `${a.nome} ficou ${a.disponivel ? 'online' : 'offline'}`, dados: { userId: a.userId },
      });
    }
    for (const e of a.equipes) {
      if (!b.equipes.includes(e)) {
        r.push({ nivel: 'info', tipo: 'atendente_entrou_equipe', mensagem: `${a.nome} passou a atender ${nomeEquipe(e)}`, dados: { userId: a.userId, equipeId: e } });
      }
    }
    for (const e of b.equipes) {
      if (!a.equipes.includes(e)) {
        r.push({ nivel: 'info', tipo: 'atendente_saiu_equipe', mensagem: `${a.nome} deixou de atender ${nomeEquipe(e)}`, dados: { userId: a.userId, equipeId: e } });
      }
    }
  }
  for (const b of antes) {
    if (!mapaDepois.has(b.userId)) {
      r.push({ nivel: 'aviso', tipo: 'atendente_removido', mensagem: `Usuário removido do Pulse Direct: ${b.nome}`, dados: { userId: b.userId } });
    }
  }
  return r;
}
