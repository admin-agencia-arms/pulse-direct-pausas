// Cliente da API do Pulse Direct. O token fica apenas no servidor.
const BASE = (process.env.PULSE_API_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.PULSE_API_TOKEN || '';
const DRY_RUN = process.env.DRY_RUN === 'true';

export class CrmError extends Error {
  constructor(message, status, key) {
    super(message);
    this.status = status;
    this.key = key;
  }
}

async function call(method, path, body) {
  if (!BASE || !TOKEN) throw new CrmError('Integração com o Pulse Direct não configurada.', 500);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new CrmError('Não foi possível conectar ao Pulse Direct. Tente novamente.', 502);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
  if (!res.ok || data?.error === true) {
    throw new CrmError(data?.text || `Pulse Direct respondeu ${res.status}.`, res.status, data?.key);
  }
  return data;
}

export const listAgents = () => call('GET', '/v1/agent');
export const listDepartments = () => call('GET', '/v2/department');
export const getAgent = (userId) => call('GET', `/v1/agent/${userId}`);

/**
 * Altera apenas a disponibilidade do atendente ('AVAILABLE' | 'UNAVAILABLE').
 * Nunca altera o status (Active/Blocked): bloquear impediria o login no Pulse Direct.
 */
export async function setAvailability(user, availability) {
  if (DRY_RUN) return { dryRun: true };
  const body = { availability, fields: ['Availability'] };
  // O {id} desta rota é o userId do atendente; tenta o id do agente como alternativa.
  try {
    return await call('PUT', `/v1/agent/${user.crm_user_id}`, body);
  } catch (e) {
    if (e.key === 'ENTITY_NOT_FOUND' && user.crm_agent_id && user.crm_agent_id !== user.crm_user_id) {
      return call('PUT', `/v1/agent/${user.crm_agent_id}`, body);
    }
    throw e;
  }
}
