// Datas do Pulse Direct: vêm com e sem "Z" e com 6 a 8 casas decimais (a doc diz que tudo é UTC).
const FORMATO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/** Data → ms (o Date.parse quebra em parte dos formatos do Pulse Direct). */
export function lerData(valor) {
  if (!valor) return null;
  const m = FORMATO.exec(String(valor).trim());
  if (!m) return null;
  const ms = (m[2] ?? '').padEnd(3, '0').slice(0, 3);
  const t = Date.parse(`${m[1]}.${ms}${m[3] ?? 'Z'}`);
  return Number.isNaN(t) ? null : t;
}

/** Data → µs: o Pulse Direct guarda e compara nessa precisão, e o cursor de leitura precisa dela. */
export function lerMicros(valor) {
  if (!valor) return null;
  const m = FORMATO.exec(String(valor).trim());
  if (!m) return null;
  const fracao = (m[2] ?? '').padEnd(6, '0');
  const ms = Date.parse(`${m[1]}.${fracao.slice(0, 3)}${m[3] ?? 'Z'}`);
  return Number.isNaN(ms) ? null : ms * 1000 + Number(fracao.slice(3, 6));
}

/** µs → ISO com 6 casas (formato aceito pelos filtros do Pulse Direct). */
export function isoMicros(us) {
  const ms = Math.floor(us / 1000);
  return `${new Date(ms).toISOString().slice(0, 23)}${String(us - ms * 1000).padStart(3, '0')}Z`;
}

/** Instante (UTC) da meia-noite de hoje no fuso informado. */
export function inicioDoDia(agora, fuso = 'America/Sao_Paulo') {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(agora).map((p) => [p.type, p.value]),
  );
  const ano = Number(partes.year), mes = Number(partes.month) - 1, dia = Number(partes.day);
  const localComoUtc = Date.UTC(ano, mes, dia, Number(partes.hour), Number(partes.minute), Number(partes.second));
  const deslocamento = localComoUtc - Math.floor(agora / 1000) * 1000;
  return Date.UTC(ano, mes, dia) - deslocamento;
}
