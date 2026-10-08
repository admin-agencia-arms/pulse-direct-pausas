// Pulse Direct · Gestão de Pausas — SPA sem dependências
const $app = document.getElementById('app');
const S = { me: null, offset: 0, poll: null, route: null, team: { q: '', dep: '', state: '' }, reportSort: { key: 'name', dir: 1 } };
const now = () => Date.now() + S.offset;

// ---------------- Utilidades ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  return `${h ? h + ':' : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function fmtDur(ms) {
  const m = Math.floor(Math.max(0, ms || 0) / 60000);
  if (m < 60) return `${m}min`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}min`;
}
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function fmtDay(key, withWeekday = true) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = dt.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return withWeekday ? `${wd}, ${pad(d)}/${pad(m)}` : `${pad(d)}/${pad(m)}/${y}`;
}
const localKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return localKey(new Date(y, m - 1, d + n)); };
const initials = (n) => String(n || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const firstName = (n) => { const f = String(n || '').trim().split(/\s+/)[0] || ''; return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase(); };
const titleCase = (n) => String(n || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (w) => w.toLowerCase());
const PROFILE = { ADMIN: 'Administrador', AGENT: 'Atendente', RESTRICTED_AGENT: 'Atendente restrito', SUPERVISOR: 'Supervisor' };
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* vazio */ }
  if (res.status === 401 && !path.startsWith('/auth')) {
    S.me = null;
    renderLogin();
    throw new Error(data?.error || 'Sessão expirada.');
  }
  if (!res.ok) throw new Error(data?.error || 'Falha na requisição.');
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

function modal(html, { wide = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  bg.addEventListener('mousedown', (e) => e.target === bg && close());
  bg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  return { el: bg.querySelector('.modal'), close };
}

function confirmDialog(title, text, okLabel = 'Confirmar', okClass = 'primary') {
  return new Promise((resolve) => {
    const m = modal(`
      <div class="modal-head"><h2>${esc(title)}</h2></div>
      <p class="muted" style="margin:0">${text}</p>
      <div class="modal-foot"><button class="btn" data-close>Cancelar</button><button class="btn ${okClass}" id="ok">${esc(okLabel)}</button></div>`);
    let done = false;
    m.el.querySelector('#ok').onclick = () => { done = true; m.close(); resolve(true); };
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

async function busy(btn, fn) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>'; }
  try { return await fn(); } finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = old; } }
}

// ---------------- Relógio ao vivo ----------------
// data-since="ts"                -> cronômetro desde ts
// data-base="ms" data-from="ts"  -> duração acumulada que cresce desde ts
// data-limit="startTs,limitMs"   -> barra de limite / classe de excedido
function tick() {
  const t = now();
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtClock(t - Number(el.dataset.since)); });
  document.querySelectorAll('[data-base]').forEach((el) => {
    const grow = el.dataset.from ? t - Number(el.dataset.from) : 0;
    el.textContent = fmtDur(Number(el.dataset.base) + grow);
  });
  document.querySelectorAll('[data-limit]').forEach((el) => {
    const [start, limit] = el.dataset.limit.split(',').map(Number);
    const elapsed = t - start;
    const over = elapsed > limit;
    if (el.dataset.role === 'bar') el.style.width = Math.min(100, (elapsed / limit) * 100) + '%';
    else if (el.dataset.role === 'remain') el.textContent = over ? `Excedido em ${fmtClock(elapsed - limit)}` : `Restam ${fmtClock(limit - elapsed)}`;
    else if (el.dataset.role === 'hero') { el.classList.toggle('s-over', over); el.classList.toggle('s-pause', !over); }
    else if (el.dataset.role === 'pill') { el.classList.toggle('over', over); el.classList.toggle('pause', !over); }
    else if (el.dataset.role === 'notice') el.classList.toggle('hidden', !over);
  });
}
setInterval(tick, 1000);

function setPoll(fn, ms) {
  clearInterval(S.poll);
  S.poll = fn ? setInterval(fn, ms) : null;
}

// ---------------- Login ----------------
const PULSE_SVG = `<svg class="pulse-line" viewBox="0 0 600 80" preserveAspectRatio="none" height="80" width="100%"><path d="M0 40h180l20-30 30 60 25-45 15 15h330" fill="none" stroke="#fff" stroke-width="3"/></svg>`;

function renderLogin(state = { step: 'email', email: '' }, error = '') {
  setPoll(null);
  const { step, email, name } = state;
  let body;
  if (step === 'email') {
    body = `
      <h2>Entrar</h2>
      <p class="sub">Use o mesmo e-mail cadastrado no Pulse Direct.</p>
      ${error ? `<div class="error-msg">${esc(error)}</div>` : ''}
      <form id="f">
        <div class="field"><label for="email">E-mail</label>
          <input class="input" id="email" type="email" autocomplete="username" required value="${esc(email)}" placeholder="voce@empresa.com" autofocus></div>
        <button class="btn primary block lg" type="submit">Continuar</button>
      </form>`;
  } else if (step === 'login') {
    body = `
      <h2>${name ? `Olá, ${esc(firstName(name))}` : 'Bem-vindo(a) de volta'}</h2>
      <p class="sub">Digite sua senha para acessar.</p>
      ${error ? `<div class="error-msg">${esc(error)}</div>` : ''}
      <div class="email-chip"><span>${esc(email)}</span><button class="link-btn" id="back" type="button">Trocar</button></div>
      <form id="f">
        <input type="email" autocomplete="username" value="${esc(email)}" hidden>
        <div class="field"><label for="pw">Senha</label>
          <input class="input" id="pw" type="password" autocomplete="current-password" required autofocus></div>
        <button class="btn primary block lg" type="submit">Entrar</button>
      </form>
      <p class="hint" style="margin-top:16px">Esqueceu a senha? Peça a um administrador para redefinir seu acesso.</p>`;
  } else {
    body = `
      <h2>Primeiro acesso${name ? `, ${esc(firstName(name))}` : ''}</h2>
      <p class="sub">Encontramos seu usuário no Pulse Direct. Crie uma senha para continuar.</p>
      ${error ? `<div class="error-msg">${esc(error)}</div>` : ''}
      <div class="email-chip"><span>${esc(email)}</span><button class="link-btn" id="back" type="button">Trocar</button></div>
      <form id="f">
        <input type="email" autocomplete="username" value="${esc(email)}" hidden>
        <div class="field"><label for="pw">Nova senha</label>
          <input class="input" id="pw" type="password" autocomplete="new-password" required minlength="8" autofocus>
          <span class="hint">Mínimo de 8 caracteres, com letras e números.</span></div>
        <div class="field"><label for="pw2">Confirmar senha</label>
          <input class="input" id="pw2" type="password" autocomplete="new-password" required minlength="8"></div>
        <button class="btn primary block lg" type="submit">Criar senha e entrar</button>
      </form>`;
  }
  $app.innerHTML = `
    <div class="auth-wrap">
      <aside class="auth-side">
        <div class="brand"><img src="/logo.svg" alt=""><div>Pulse Direct<small>GESTÃO DE PAUSAS</small></div></div>
        <div>
          <h1>Sua jornada,<br>no seu ritmo.</h1>
          <p>Registre pausas com motivo, acompanhe seu tempo ativo e mantenha sua disponibilidade sincronizada com o Pulse Direct.</p>
          <div class="auth-feats">
            <div><span>✓</span>Disponibilidade atualizada na hora</div>
            <div><span>⏱</span>Tempo de pausa e de atividade por dia</div>
            <div><span>▤</span>Visão de equipe para supervisores</div>
          </div>
        </div>
        <div class="small" style="opacity:.6">© ${new Date().getFullYear()} Pulse Direct</div>
        ${PULSE_SVG}
      </aside>
      <main class="auth-main"><div class="auth-card">
        <div class="brand" style="margin-bottom:28px"><img src="/logo.svg" alt=""><div>Pulse Direct<small>GESTÃO DE PAUSAS</small></div></div>
        ${body}
      </div></main>
    </div>`;
  $app.querySelector('#back')?.addEventListener('click', () => renderLogin({ step: 'email', email }));
  const f = $app.querySelector('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    try {
      await busy(btn, async () => {
        if (step === 'email') {
          const em = f.querySelector('#email').value.trim();
          const r = await api('/auth/check', { method: 'POST', body: { email: em } });
          renderLogin({ step: r.step, email: em, name: r.name });
        } else if (step === 'login') {
          await api('/auth/login', { method: 'POST', body: { email, password: f.querySelector('#pw').value } });
          await boot();
        } else {
          await api('/auth/first-access', { method: 'POST', body: { email, password: f.querySelector('#pw').value, confirm: f.querySelector('#pw2').value } });
          toast('Senha criada com sucesso!', 'ok');
          await boot();
        }
      });
    } catch (err) {
      renderLogin(state, err.message);
    }
  });
}

// ---------------- Shell ----------------
function shell(active) {
  const u = S.me.user;
  const isAdmin = u.role === 'admin';
  const links = [
    ...(u.isAgent ? [['/', 'Meu painel']] : []),
    ...(isAdmin ? [['/equipe', 'Equipe'], ['/relatorios', 'Relatórios'], ['/motivos', 'Motivos de pausa'], ['/usuarios', 'Usuários'], ['/distribuicao', 'Distribuição']] : []),
  ];
  $app.innerHTML = `
    <header class="topbar"><div class="topbar-inner">
      <div class="brand"><img src="/logo.svg" alt=""><div class="txt">Pulse Direct<small>GESTÃO DE PAUSAS</small></div></div>
      <nav class="nav">${links.map(([h, l]) => `<a href="#${h}" class="${h === active ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <div class="user-menu">
        <button class="user-btn" id="ubtn"><div class="meta"><b>${esc(titleCase(u.name))}</b><span>${isAdmin ? 'Administrador' : 'Usuário'}</span></div><div class="avatar">${esc(initials(u.name))}</div></button>
        <div class="dropdown hidden" id="udrop">
          <div class="small muted" style="padding:8px 12px 6px">${esc(u.email)}</div>
          <button id="chpw">Alterar senha</button>
          <button id="logout" style="color:var(--danger)">Sair</button>
        </div>
      </div>
    </div></header>
    <main class="page" id="page"><div class="boot" style="min-height:40vh"><div class="spinner"></div></div></main>`;
  const drop = $app.querySelector('#udrop');
  $app.querySelector('#ubtn').onclick = (e) => { e.stopPropagation(); drop.classList.toggle('hidden'); };
  document.addEventListener('click', () => drop.classList.add('hidden'), { once: true });
  $app.querySelector('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); S.me = null; renderLogin(); };
  $app.querySelector('#chpw').onclick = changePasswordModal;
  return $app.querySelector('#page');
}

function changePasswordModal() {
  const m = modal(`
    <div class="modal-head"><h2>Alterar senha</h2><button class="btn ghost sm" data-close>✕</button></div>
    <form id="f">
      <div class="field"><label>Senha atual</label><input class="input" type="password" id="cur" autocomplete="current-password" required></div>
      <div class="field"><label>Nova senha</label><input class="input" type="password" id="pw" autocomplete="new-password" required minlength="8"><span class="hint">Mínimo de 8 caracteres, com letras e números.</span></div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Salvar</button></div>
    </form>`);
  m.el.querySelector('[data-close]').onclick = m.close;
  m.el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(e.submitter, () => api('/me/password', { method: 'PUT', body: { current: m.el.querySelector('#cur').value, password: m.el.querySelector('#pw').value } }));
      m.close();
      toast('Senha alterada.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---------------- Pausa (modal compartilhado) ----------------
function pauseModal(reasons, who, onConfirm) {
  let sel = null;
  const m = modal(`
    <div class="modal-head"><div><h2>Iniciar pausa</h2>${who ? `<p class="muted small" style="margin:4px 0 0">${esc(who)}</p>` : ''}</div><button class="btn ghost sm" data-close>✕</button></div>
    <p class="muted" style="margin:0 0 14px">Selecione o motivo. ${who ? 'O atendente' : 'Você'} ficará indisponível no Pulse Direct durante a pausa.</p>
    <div class="reason-grid">${reasons.map((r) => `
      <button class="reason-opt" data-id="${r.id}" style="--c:${esc(r.color)}">
        <i></i><b>${esc(r.name)}</b><span>${r.max_minutes ? `Limite de ${r.max_minutes} min` : 'Sem limite'}</span>
      </button>`).join('')}</div>
    <div class="field section-gap"><label for="note">Observação <span class="muted">(opcional)</span></label>
      <textarea class="input" id="note" maxlength="300" placeholder="Ex.: reunião com a supervisão"></textarea></div>
    <div class="modal-foot"><button class="btn" data-close>Cancelar</button><button class="btn warn" id="go" disabled>Iniciar pausa</button></div>`);
  m.el.querySelectorAll('.reason-opt').forEach((b) => b.addEventListener('click', () => {
    m.el.querySelectorAll('.reason-opt').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    sel = Number(b.dataset.id);
    m.el.querySelector('#go').disabled = false;
  }));
  m.el.querySelector('#go').onclick = async (e) => {
    try {
      await busy(e.currentTarget, () => onConfirm(sel, m.el.querySelector('#note').value));
      m.close();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---------------- Meu painel ----------------
const reasonColor = (reasons, id) => reasons.find((r) => r.id === id)?.color || 'var(--warn)';

async function viewMe(page) {
  let histDays = 7;
  const load = async () => {
    const [me, st] = await Promise.all([api('/me'), api(`/me/stats?from=${addDays(localKey(), -(histDays - 1))}&to=${localKey()}`)]);
    S.offset = me.serverNow - Date.now();
    S.me = me;
    draw(me, st);
  };

  const draw = (me, st) => {
    const { state, current: cur, reasons, today } = me;
    const tActive = today?.active || 0;
    const tPause = today?.pause || 0;
    const growA = state === 'active' ? me.serverNow : '';
    const growP = state === 'pause' ? me.serverNow : '';
    let hero;
    if (!me.user.isAgent) {
      hero = `<div class="card hero"><div><div class="state-label">Conta administrativa</div><div class="state-title">Sem vínculo de atendente</div>
        <p class="muted">Esta conta não corresponde a um atendente do Pulse Direct. Use as abas de equipe e relatórios.</p></div></div>`;
    } else if (state === 'offline') {
      hero = `<div class="card hero s-offline">
        <div><div class="state-label"><span class="dot"></span>Fora de jornada</div>
        <div class="state-title">Você está indisponível</div>
        <p class="muted" style="margin:0">Inicie a jornada para ficar disponível para atendimentos no Pulse Direct.</p></div>
        <div class="hero-actions"><button class="btn primary lg" id="a-start">▶ Iniciar jornada</button></div></div>`;
    } else if (state === 'active') {
      hero = `<div class="card hero s-active">
        <div class="hero-top"><div><div class="state-label"><span class="dot live"></span>Disponível</div>
          <div class="muted" style="margin-top:6px">Disponível há</div></div>
          <div class="muted small" style="text-align:right">Jornada iniciada às <b>${fmtTime(me.shiftStartedAt)}</b></div></div>
        <div class="timer" data-since="${cur.startedAt}">${fmtClock(now() - cur.startedAt)}</div>
        <div class="hero-actions"><button class="btn warn lg" id="a-pause">❚❚ Pausar</button><button class="btn lg" id="a-end">Encerrar jornada</button></div></div>`;
    } else {
      const lim = cur.maxMinutes ? `${cur.startedAt},${cur.maxMinutes * 60000}` : '';
      hero = `<div class="card hero s-pause" ${lim ? `data-limit="${lim}" data-role="hero"` : ''}>
        <div class="hero-top"><div><div class="state-label"><span class="dot live"></span>Em pausa</div>
          <div class="state-title">${esc(cur.reason)}</div>${cur.note ? `<div class="muted small">${esc(cur.note)}</div>` : ''}</div>
          <div class="muted small" style="text-align:right">Pausa iniciada às <b>${fmtTime(cur.startedAt)}</b></div></div>
        <div>
          <div class="timer" data-since="${cur.startedAt}">${fmtClock(now() - cur.startedAt)}</div>
          ${lim ? `<div class="limit-bar"><i data-limit="${lim}" data-role="bar"></i></div>
            <div class="small muted" style="margin-top:6px;display:flex;justify-content:space-between"><span>Limite: ${cur.maxMinutes} min</span><span data-limit="${lim}" data-role="remain"></span></div>` : ''}
        </div>
        ${lim ? `<div class="notice hidden" data-limit="${lim}" data-role="notice">Tempo de pausa excedido. Retome o atendimento assim que possível.</div>` : ''}
        <div class="hero-actions"><button class="btn ok lg" id="a-resume">▶ Retomar atendimento</button><button class="btn lg" id="a-end">Encerrar jornada</button></div></div>`;
    }

    const pausesToday = me.timeline.filter((i) => i.kind === 'pause').reverse();
    const hist = st.days;
    page.innerHTML = `
      <div class="page-head"><div><h1>Olá, ${esc(firstName(me.user.name))}</h1>
        <p>${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}</p></div></div>
      <div class="grid grid-2">
        ${hero}
        <div class="card card-pad">
          <h3>Hoje</h3>
          <div class="kpis" style="grid-template-columns:1fr 1fr">
            <div class="kpi card" style="box-shadow:none"><div class="label">Tempo ativo</div><div class="value ok num" data-base="${tActive}" ${growA ? `data-from="${growA}"` : ''}>${fmtDur(tActive)}</div></div>
            <div class="kpi card" style="box-shadow:none"><div class="label">Tempo em pausa</div><div class="value warn num" data-base="${tPause}" ${growP ? `data-from="${growP}"` : ''}>${fmtDur(tPause)}</div></div>
            <div class="kpi card" style="box-shadow:none"><div class="label">Pausas</div><div class="value num">${today?.pauses || 0}</div></div>
            <div class="kpi card" style="box-shadow:none"><div class="label">Acima do limite</div><div class="value num ${today?.overLimit ? 'danger' : ''}">${today?.overLimit || 0}</div></div>
          </div>
          <h3 class="section-gap" style="margin-top:20px">Pausas de hoje</h3>
          ${pausesToday.length ? `<div class="pause-list">${pausesToday.map((p) => {
            const dur = (p.end ?? now()) - p.start;
            const over = p.maxMinutes && dur > p.maxMinutes * 60000;
            return `<div class="pause-item"><span class="sw" style="background:${esc(reasonColor(reasons, p.reasonId))}"></span>
              <div class="grow"><b>${esc(p.reason)}</b><div>${fmtTime(p.start)} – ${p.end ? fmtTime(p.end) : 'agora'}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
              <span class="pill ${over ? 'over' : 'offline'} num">${p.end ? fmtDur(dur) : `<span data-since="${p.start}"></span>`}</span></div>`;
          }).join('')}</div>` : '<div class="muted small">Nenhuma pausa registrada hoje.</div>'}
        </div>
      </div>
      <div class="card card-pad section-gap">
        <h3>Linha do tempo de hoje</h3>
        ${timeline(me.timeline, reasons)}
      </div>
      <div class="card section-gap">
        <div class="toolbar" style="justify-content:space-between"><b>Histórico</b>
          <div class="seg-ctl">${[7, 15, 30].map((d) => `<button data-days="${d}" class="${d === histDays ? 'on' : ''}">${d} dias</button>`).join('')}</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Dia</th><th>Início</th><th>Fim</th><th class="right">Tempo ativo</th><th class="right">Tempo em pausa</th><th class="right">Pausas</th><th class="right">Acima do limite</th></tr></thead>
          <tbody>${hist.length ? hist.map((d) => `<tr><td>${fmtDay(d.date)}</td><td class="num">${fmtTime(d.first)}</td><td class="num">${fmtTime(d.last)}</td>
            <td class="right num">${fmtDur(d.active)}</td><td class="right num">${fmtDur(d.pause)}</td><td class="right num">${d.pauses}</td>
            <td class="right num">${d.overLimit ? `<span class="pill over">${d.overLimit}</span>` : '0'}</td></tr>`).join('')
            : '<tr><td colspan="7" class="empty">Sem registros no período.</td></tr>'}</tbody>
          ${st.total ? `<tfoot><tr><th>Total</th><th></th><th></th><th class="right num">${fmtDur(st.total.active)}</th><th class="right num">${fmtDur(st.total.pause)}</th><th class="right num">${st.total.pauses}</th><th class="right num">${st.total.overLimit}</th></tr></tfoot>` : ''}
        </table></div>
      </div>`;
    tick();

    const act = (path, msg) => async (e) => {
      try { await busy(e.currentTarget, () => api(path, { method: 'POST' })); toast(msg, 'ok'); await load(); } catch (err) { toast(err.message, 'error'); }
    };
    page.querySelector('#a-start')?.addEventListener('click', act('/me/start', 'Jornada iniciada. Você está disponível.'));
    page.querySelector('#a-resume')?.addEventListener('click', act('/me/resume', 'Pausa encerrada. Você está disponível.'));
    page.querySelector('#a-pause')?.addEventListener('click', () => pauseModal(reasons, null, async (reasonId, note) => {
      await api('/me/pause', { method: 'POST', body: { reasonId, note } });
      toast('Pausa iniciada.', 'ok');
      await load();
    }));
    page.querySelector('#a-end')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (await confirmDialog('Encerrar jornada?', 'Você ficará indisponível no Pulse Direct até iniciar uma nova jornada.', 'Encerrar jornada')) {
        act('/me/end', 'Jornada encerrada.')({ currentTarget: btn });
      }
    });
    page.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', async () => { histDays = Number(b.dataset.days); await load(); }));
  };

  await load();
  setPoll(() => load().catch(() => {}), 30000);
}

function timeline(segs, reasons) {
  if (!segs.length) return '<div class="muted small">Sua jornada de hoje ainda não começou.</div>';
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const first = Math.max(day0.getTime(), segs[0].start);
  const t = now();
  const startH = new Date(first); startH.setMinutes(0, 0, 0);
  let s = startH.getTime();
  let e = Math.max(t, ...segs.map((x) => x.end || t));
  e = Math.ceil(e / 3600000) * 3600000;
  if (e - s < 4 * 3600000) e = s + 4 * 3600000;
  const span = e - s;
  const pos = (x) => ((x - s) / span) * 100;
  const used = new Map();
  const bars = segs.map((x) => {
    const a = Math.max(x.start, s), b = Math.min(x.end ?? t, e);
    const color = x.kind === 'pause' ? reasonColor(reasons, x.reasonId) : '';
    if (x.kind === 'pause') used.set(x.reason, color);
    const tip = `${x.kind === 'pause' ? x.reason : 'Disponível'} · ${fmtTime(x.start)}–${x.end ? fmtTime(x.end) : 'agora'} (${fmtDur((x.end ?? t) - x.start)})`;
    return `<div class="seg ${x.kind}" title="${esc(tip)}" style="left:${pos(a)}%;width:${pos(b) - pos(a)}%;${color ? `background:${esc(color)}` : ''}"></div>`;
  }).join('');
  const hours = span / 3600000;
  const step = hours <= 6 ? 1 : hours <= 12 ? 2 : 3;
  const ticks = [];
  for (let h = 0; h <= hours; h += step) ticks.push(`<span>${pad(new Date(s + h * 3600000).getHours())}h</span>`);
  return `<div class="timeline">${bars}<div class="now" style="left:${pos(t)}%"></div></div>
    <div class="tl-axis">${ticks.join('')}</div>
    <div class="legend"><span><i style="background:var(--ok)"></i>Disponível</span>${[...used].map(([n, c]) => `<span><i style="background:${esc(c)}"></i>${esc(n)}</span>`).join('')}</div>`;
}

// ---------------- Equipe (admin) ----------------
function statusPill(m) {
  if (m.state === 'active') return '<span class="pill active"><span class="dot"></span>Disponível</span>';
  if (m.state === 'pause') {
    const c = m.current;
    const lim = c.maxMinutes ? `data-limit="${c.startedAt},${c.maxMinutes * 60000}" data-role="pill"` : '';
    return `<span class="pill pause" ${lim}><span class="dot"></span>${esc(c.reason)}</span>`;
  }
  return '<span class="pill offline"><span class="dot"></span>Fora de jornada</span>';
}
const isOver = (m) => m.state === 'pause' && m.current.maxMinutes && now() - m.current.startedAt > m.current.maxMinutes * 60000;
const deps = (ids, map) => ids.map((d) => map[d]).filter(Boolean);

async function viewTeam(page) {
  let data = null;
  page.innerHTML = `
    <div class="page-head"><div><h1>Equipe</h1><p>Status em tempo real dos atendentes. Atualiza a cada 10 segundos.</p></div></div>
    <div class="kpis" id="kpis"></div>
    <div class="card section-gap">
      <div class="toolbar">
        <input class="input search" id="q" placeholder="Buscar atendente ou e-mail…" value="${esc(S.team.q)}">
        <select class="input" id="dep"><option value="">Todas as equipes</option></select>
        <div class="seg-ctl" id="stf">${[['', 'Todos'], ['active', 'Disponíveis'], ['pause', 'Em pausa'], ['offline', 'Fora']].map(([v, l]) => `<button data-v="${v}" class="${S.team.state === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Atendente</th><th>Equipes</th><th>Status</th><th>No status há</th><th class="right">Ativo hoje</th><th class="right">Pausa hoje</th><th class="right">Pausas</th><th class="right">Ações</th></tr></thead>
        <tbody id="tb"><tr><td colspan="8" class="empty"><div class="spinner" style="margin:auto"></div></td></tr></tbody>
      </table></div>
    </div>`;

  const draw = () => {
    if (!data) return;
    const { members, departments, serverNow } = data;
    const counts = { active: 0, pause: 0, offline: 0, over: 0 };
    members.forEach((m) => { counts[m.state]++; if (isOver(m)) counts.over++; });
    page.querySelector('#kpis').innerHTML = `
      <div class="kpi card"><div class="label">Disponíveis</div><div class="value ok num">${counts.active}</div></div>
      <div class="kpi card"><div class="label">Em pausa</div><div class="value warn num">${counts.pause}</div></div>
      <div class="kpi card"><div class="label">Pausa excedida</div><div class="value num ${counts.over ? 'danger' : ''}">${counts.over}</div></div>
      <div class="kpi card"><div class="label">Fora de jornada</div><div class="value off num">${counts.offline}</div></div>`;
    const q = S.team.q.toLowerCase();
    const order = (m) => (isOver(m) ? 0 : m.state === 'pause' ? 1 : m.state === 'active' ? 2 : 3);
    const list = members
      .filter((m) => (!S.team.state || m.state === S.team.state) && (!S.team.dep || m.departments.includes(S.team.dep)) && (!q || m.name.toLowerCase().includes(q) || m.email.includes(q)))
      .sort((a, b) => order(a) - order(b) || (a.state !== 'offline' && b.state !== 'offline' ? a.current.startedAt - b.current.startedAt : 0) || a.name.localeCompare(b.name));
    page.querySelector('#tb').innerHTML = list.length ? list.map((m) => {
      const t = m.today || { active: 0, pause: 0, pauses: 0, overLimit: 0 };
      const ds = deps(m.departments, departments);
      return `<tr>
        <td><div class="person"><div class="avatar">${esc(initials(m.name))}</div><div><b>${esc(titleCase(m.name))}</b><span>${esc(m.email)}</span></div></div></td>
        <td>${ds.slice(0, 2).map((d) => `<span class="tag">${esc(d)}</span>`).join('')}${ds.length > 2 ? `<span class="tag" title="${esc(ds.slice(2).join(', '))}">+${ds.length - 2}</span>` : ''}</td>
        <td>${statusPill(m)}</td>
        <td class="num">${m.current ? `<span data-since="${m.current.startedAt}"></span>` : '<span class="muted">—</span>'}</td>
        <td class="right num" data-base="${t.active}" ${m.state === 'active' ? `data-from="${serverNow}"` : ''}></td>
        <td class="right num" data-base="${t.pause}" ${m.state === 'pause' ? `data-from="${serverNow}"` : ''}></td>
        <td class="right num">${t.pauses}${t.overLimit ? ` <span class="pill over" title="Acima do limite">${t.overLimit}</span>` : ''}</td>
        <td><div class="row-actions">
          ${m.state === 'offline' ? `<button class="btn sm" data-act="start" data-id="${m.id}">Iniciar</button>` : ''}
          ${m.state === 'active' ? `<button class="btn sm" data-act="pause" data-id="${m.id}">Pausar</button>` : ''}
          ${m.state === 'pause' ? `<button class="btn sm" data-act="resume" data-id="${m.id}">Retomar</button>` : ''}
          ${m.state !== 'offline' ? `<button class="btn sm danger-ghost" data-act="end" data-id="${m.id}">Encerrar</button>` : ''}
          <button class="btn sm ghost" data-act="hist" data-id="${m.id}" title="Histórico">Histórico</button>
        </div></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="empty">Nenhum atendente encontrado.</td></tr>';
    tick();
  };

  const load = async () => {
    const d = await api('/admin/team');
    S.offset = d.serverNow - Date.now();
    const first = !data;
    data = d;
    if (first) {
      const sel = page.querySelector('#dep');
      const used = new Set(d.members.flatMap((m) => m.departments));
      Object.entries(d.departments).filter(([id]) => used.has(id)).sort((a, b) => a[1].localeCompare(b[1]))
        .forEach(([id, n]) => sel.insertAdjacentHTML('beforeend', `<option value="${esc(id)}" ${S.team.dep === id ? 'selected' : ''}>${esc(n)}</option>`));
    }
    draw();
  };

  page.querySelector('#q').addEventListener('input', (e) => { S.team.q = e.target.value; draw(); });
  page.querySelector('#dep').addEventListener('change', (e) => { S.team.dep = e.target.value; draw(); });
  page.querySelectorAll('#stf button').forEach((b) => b.addEventListener('click', () => {
    S.team.state = b.dataset.v;
    page.querySelectorAll('#stf button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  }));
  page.querySelector('#tb').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const m = data.members.find((x) => x.id === Number(b.dataset.id));
    const name = titleCase(m.name);
    const run = async (path, body, msg) => {
      try { await busy(b, () => api(`/admin/users/${m.id}/${path}`, { method: 'POST', body })); toast(msg, 'ok'); await load(); } catch (err) { toast(err.message, 'error'); }
    };
    if (b.dataset.act === 'hist') return userDetail(m.id, addDays(localKey(), -6), localKey());
    if (b.dataset.act === 'pause') {
      return pauseModal(S.me.reasons, name, async (reasonId, note) => {
        await api(`/admin/users/${m.id}/pause`, { method: 'POST', body: { reasonId, note } });
        toast(`${name} em pausa.`, 'ok');
        await load();
      });
    }
    const labels = {
      start: ['Iniciar jornada', `Iniciar a jornada de <b>${esc(name)}</b>? O atendente ficará disponível no Pulse Direct.`, 'Jornada iniciada.'],
      resume: ['Retomar atendimento', `Encerrar a pausa de <b>${esc(name)}</b>? O atendente ficará disponível no Pulse Direct.`, 'Pausa encerrada.'],
      end: ['Encerrar jornada', `Encerrar a jornada de <b>${esc(name)}</b>? O atendente ficará indisponível no Pulse Direct.`, 'Jornada encerrada.'],
    }[b.dataset.act];
    if (await confirmDialog(labels[0], labels[1], labels[0])) run(b.dataset.act, undefined, labels[2]);
  });

  await load();
  setPoll(() => load().catch(() => {}), 10000);
}

// ---------------- Detalhe de usuário (admin) ----------------
async function userDetail(id, from, to) {
  const m = modal('<div class="boot" style="min-height:200px"><div class="spinner"></div></div>', { wide: true });
  const draw = async () => {
    const d = await api(`/admin/users/${id}/stats?from=${from}&to=${to}`);
    const t = d.total || { active: 0, pause: 0, pauses: 0, overLimit: 0, byReason: {} };
    const maxR = Math.max(1, ...Object.values(t.byReason));
    const reasonsC = Object.fromEntries(S.me.reasons.map((r) => [r.name, r.color]));
    m.el.innerHTML = `
      <div class="modal-head"><div class="person"><div class="avatar">${esc(initials(d.user.name))}</div><div><h2>${esc(titleCase(d.user.name))}</h2><span>${esc(d.user.email)}</span></div></div>
        <button class="btn ghost sm" data-x>✕</button></div>
      <div class="toolbar" style="padding:0 0 14px;border:0">
        <input type="date" class="input" id="df" value="${d.from}"><span class="muted">até</span><input type="date" class="input" id="dt" value="${d.to}">
        <button class="btn sm" id="apply">Aplicar</button></div>
      <div class="kpis">
        <div class="kpi card" style="box-shadow:none"><div class="label">Tempo ativo</div><div class="value ok num">${fmtDur(t.active)}</div></div>
        <div class="kpi card" style="box-shadow:none"><div class="label">Tempo em pausa</div><div class="value warn num">${fmtDur(t.pause)}</div></div>
        <div class="kpi card" style="box-shadow:none"><div class="label">Pausas</div><div class="value num">${t.pauses}</div></div>
        <div class="kpi card" style="box-shadow:none"><div class="label">Acima do limite</div><div class="value num ${t.overLimit ? 'danger' : ''}">${t.overLimit}</div></div>
      </div>
      <div class="grid grid-2 section-gap">
        <div class="card"><div class="table-wrap" style="max-height:340px"><table>
          <thead><tr><th>Dia</th><th>Início</th><th>Fim</th><th class="right">Ativo</th><th class="right">Pausa</th><th class="right">Pausas</th></tr></thead>
          <tbody>${d.days.length ? d.days.map((x) => `<tr><td>${fmtDay(x.date)}</td><td class="num">${fmtTime(x.first)}</td><td class="num">${fmtTime(x.last)}</td><td class="right num">${fmtDur(x.active)}</td><td class="right num">${fmtDur(x.pause)}</td><td class="right num">${x.pauses}${x.overLimit ? ` <span class="pill over">${x.overLimit}</span>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">Sem registros.</td></tr>'}</tbody>
        </table></div></div>
        <div class="card card-pad"><h3>Pausas por motivo</h3>
          ${Object.keys(t.byReason).length ? `<div class="bars">${Object.entries(t.byReason).sort((a, b) => b[1] - a[1]).map(([n, v]) => `
            <div class="bar-row"><span class="lbl">${esc(n)}</span><div class="track"><i style="width:${(v / maxR) * 100}%;background:${esc(reasonsC[n] || 'var(--warn)')}"></i></div><span class="num right">${fmtDur(v)}</span></div>`).join('')}</div>` : '<div class="muted small">Sem pausas no período.</div>'}
        </div>
      </div>
      <div class="card section-gap"><div class="toolbar"><b>Pausas registradas</b></div><div class="table-wrap" style="max-height:300px"><table>
        <thead><tr><th>Motivo</th><th>Início</th><th>Fim</th><th class="right">Duração</th><th>Observação</th></tr></thead>
        <tbody>${d.pauses.length ? d.pauses.map((p) => {
          const dur = (p.end ?? now()) - p.start;
          const over = p.maxMinutes && dur > p.maxMinutes * 60000;
          return `<tr><td>${esc(p.reason)}</td><td class="num">${fmtDateTime(p.start)}</td><td class="num">${p.end ? fmtTime(p.end) : '<span class="pill pause">Em andamento</span>'}</td><td class="right num">${over ? `<span class="pill over">${fmtDur(dur)}</span>` : fmtDur(dur)}</td><td class="muted">${esc(p.note || '')}</td></tr>`;
        }).join('') : '<tr><td colspan="5" class="empty">Sem pausas.</td></tr>'}</tbody></table></div></div>`;
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('#apply').onclick = () => { from = m.el.querySelector('#df').value; to = m.el.querySelector('#dt').value; draw().catch((e) => toast(e.message, 'error')); };
  };
  draw().catch((e) => { toast(e.message, 'error'); m.close(); });
}

// ---------------- Relatórios (admin) ----------------
async function viewReports(page) {
  const today = localKey();
  const r = S.report || (S.report = { from: addDays(today, -6), to: today, dep: '' });
  page.innerHTML = `
    <div class="page-head"><div><h1>Relatórios</h1><p>Tempo de atividade e de pausa por atendente.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" id="csv1">⬇ CSV diário</a><a class="btn" id="csv2">⬇ CSV de pausas</a></div></div>
    <div class="card"><div class="toolbar">
      <div class="seg-ctl" id="presets">
        <button data-p="0">Hoje</button><button data-p="7">7 dias</button><button data-p="30">30 dias</button><button data-p="m">Este mês</button></div>
      <input type="date" class="input" id="from" value="${r.from}"><span class="muted">até</span><input type="date" class="input" id="to" value="${r.to}">
      <select class="input" id="dep"><option value="">Todas as equipes</option></select>
      <button class="btn primary" id="go">Aplicar</button>
    </div></div>
    <div id="out" class="section-gap"><div class="boot" style="min-height:30vh"><div class="spinner"></div></div></div>`;

  let depsLoaded = false;
  const setLinks = () => {
    const qs = `from=${r.from}&to=${r.to}${r.dep ? `&department=${encodeURIComponent(r.dep)}` : ''}`;
    page.querySelector('#csv1').href = `/api/admin/report.csv?${qs}`;
    page.querySelector('#csv2').href = `/api/admin/report.csv?type=pauses&${qs}`;
    return qs;
  };
  const load = async () => {
    const qs = setLinks();
    const d = await api(`/admin/report?${qs}`);
    if (!depsLoaded) {
      depsLoaded = true;
      const used = await api('/admin/departments');
      const sel = page.querySelector('#dep');
      used.forEach((x) => sel.insertAdjacentHTML('beforeend', `<option value="${esc(x.id)}" ${r.dep === x.id ? 'selected' : ''}>${esc(x.name)}</option>`));
    }
    drawReport(page.querySelector('#out'), d);
  };
  const apply = () => {
    r.from = page.querySelector('#from').value || today;
    r.to = page.querySelector('#to').value || today;
    r.dep = page.querySelector('#dep').value;
    load().catch((e) => toast(e.message, 'error'));
  };
  page.querySelector('#go').onclick = apply;
  page.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.p;
    page.querySelector('#to').value = today;
    page.querySelector('#from').value = p === 'm' ? today.slice(0, 8) + '01' : addDays(today, -(Math.max(1, Number(p)) - 1));
    apply();
  }));
  await load();
  setPoll(null);
}

function drawReport(out, d) {
  const rows = d.rows.map((u) => {
    const t = u.total || { active: 0, pause: 0, pauses: 0, overLimit: 0 };
    return { ...u, active: t.active, pause: t.pause, pauses: t.pauses, overLimit: t.overLimit, avg: u.daysWorked ? t.active / u.daysWorked : 0, pct: pct(t.pause, t.active + t.pause) };
  });
  const sum = rows.reduce((a, x) => ({ active: a.active + x.active, pause: a.pause + x.pause, pauses: a.pauses + x.pauses, over: a.over + x.overLimit }), { active: 0, pause: 0, pauses: 0, over: 0 });
  const withData = rows.filter((x) => x.active + x.pause > 0).length;
  const reasonsC = Object.fromEntries(S.me.reasons.map((r) => [r.name, r.color]));
  const br = Object.entries(d.byReason).sort((a, b) => b[1] - a[1]);
  const maxR = Math.max(1, ...br.map((x) => x[1]));
  const { key, dir } = S.reportSort;
  rows.sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) : a[key] - b[key]) * dir);
  const th = (k, l, right = true) => `<th class="${right ? 'right' : ''}" data-sort="${k}" style="cursor:pointer">${l}${key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  out.innerHTML = `
    <div class="kpis">
      <div class="kpi card"><div class="label">Tempo ativo total</div><div class="value ok num">${fmtDur(sum.active)}</div><div class="small muted">${withData} atendente(s) com registro</div></div>
      <div class="kpi card"><div class="label">Tempo em pausa total</div><div class="value warn num">${fmtDur(sum.pause)}</div><div class="small muted">${pct(sum.pause, sum.active + sum.pause)}% da jornada</div></div>
      <div class="kpi card"><div class="label">Pausas</div><div class="value num">${sum.pauses}</div><div class="small muted">média de ${sum.pauses ? fmtDur(sum.pause / sum.pauses) : '0min'} por pausa</div></div>
      <div class="kpi card"><div class="label">Acima do limite</div><div class="value num ${sum.over ? 'danger' : ''}">${sum.over}</div><div class="small muted">${pct(sum.over, sum.pauses)}% das pausas</div></div>
    </div>
    <div class="grid section-gap" style="grid-template-columns:1fr">
      <div class="card card-pad"><h3>Pausas por motivo</h3>
        ${br.length ? `<div class="bars">${br.map(([n, v]) => `<div class="bar-row"><span class="lbl">${esc(n)}</span><div class="track"><i style="width:${(v / maxR) * 100}%;background:${esc(reasonsC[n] || 'var(--warn)')}"></i></div><span class="num right">${fmtDur(v)}</span></div>`).join('')}</div>` : '<div class="muted small">Sem pausas no período.</div>'}
      </div>
    </div>
    <div class="card section-gap"><div class="toolbar"><b>Por atendente</b><span class="muted small">${fmtDay(d.from, false)} a ${fmtDay(d.to, false)} · clique em uma linha para ver o detalhe</span></div>
      <div class="table-wrap"><table>
        <thead><tr>${th('name', 'Atendente', false)}${th('daysWorked', 'Dias')}${th('active', 'Tempo ativo')}${th('avg', 'Média ativo/dia')}${th('pause', 'Tempo em pausa')}${th('pct', '% pausa')}${th('pauses', 'Pausas')}${th('overLimit', 'Excedidas')}</tr></thead>
        <tbody>${rows.length ? rows.map((u) => `<tr class="clickable" data-id="${u.id}">
          <td><div class="person"><div class="avatar">${esc(initials(u.name))}</div><div><b>${esc(titleCase(u.name))}</b><span>${esc(u.email)}</span></div></div></td>
          <td class="right num">${u.daysWorked}</td><td class="right num">${fmtDur(u.active)}</td><td class="right num">${fmtDur(u.avg)}</td>
          <td class="right num">${fmtDur(u.pause)}</td><td class="right num">${u.pct}%</td><td class="right num">${u.pauses}</td>
          <td class="right num">${u.overLimit ? `<span class="pill over">${u.overLimit}</span>` : '0'}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">Nenhum atendente.</td></tr>'}</tbody>
      </table></div></div>`;
  out.querySelectorAll('[data-sort]').forEach((h) => h.addEventListener('click', () => {
    const k = h.dataset.sort;
    S.reportSort = { key: k, dir: S.reportSort.key === k ? -S.reportSort.dir : k === 'name' ? 1 : -1 };
    drawReport(out, d);
  }));
  out.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => userDetail(Number(tr.dataset.id), d.from, d.to)));
}

// ---------------- Motivos (admin) ----------------
async function viewReasons(page) {
  setPoll(null);
  const load = async () => {
    const list = await api('/admin/reasons');
    page.innerHTML = `
      <div class="page-head"><div><h1>Motivos de pausa</h1><p>Defina os motivos disponíveis e o tempo máximo de cada pausa.</p></div>
        <button class="btn primary" id="new">+ Novo motivo</button></div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Motivo</th><th>Tempo máximo</th><th>Status</th><th class="right">Ações</th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td><div class="person"><span style="width:14px;height:14px;border-radius:4px;background:${esc(r.color)}"></span><b>${esc(r.name)}</b></div></td>
          <td class="num">${r.max_minutes ? `${r.max_minutes} min` : '<span class="muted">Sem limite</span>'}</td>
          <td>${r.active ? '<span class="pill active">Ativo</span>' : '<span class="pill offline">Inativo</span>'}</td>
          <td><div class="row-actions"><button class="btn sm" data-edit="${r.id}">Editar</button>
            <button class="btn sm ${r.active ? 'danger-ghost' : ''}" data-tog="${r.id}">${r.active ? 'Desativar' : 'Ativar'}</button></div></td></tr>`).join('')}</tbody>
      </table></div></div>`;
    page.querySelector('#new').onclick = () => reasonForm(null, load);
    page.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => reasonForm(list.find((r) => r.id === Number(b.dataset.edit)), load)));
    page.querySelectorAll('[data-tog]').forEach((b) => b.addEventListener('click', async () => {
      const r = list.find((x) => x.id === Number(b.dataset.tog));
      try {
        await busy(b, () => api(`/admin/reasons/${r.id}`, { method: 'PUT', body: { name: r.name, color: r.color, maxMinutes: r.max_minutes, active: !r.active } }));
        await refreshReasons(); await load();
      } catch (e) { toast(e.message, 'error'); }
    }));
  };
  await load();
}

async function refreshReasons() {
  const me = await api('/me');
  S.me.reasons = me.reasons;
}

function reasonForm(r, done) {
  const m = modal(`
    <div class="modal-head"><h2>${r ? 'Editar motivo' : 'Novo motivo'}</h2><button class="btn ghost sm" data-close>✕</button></div>
    <form id="f">
      <div class="field"><label>Nome</label><input class="input" id="n" required maxlength="60" value="${esc(r?.name || '')}" placeholder="Ex.: Almoço"></div>
      <div class="inline-form" style="grid-template-columns:1fr auto">
        <div class="field"><label>Tempo máximo (minutos)</label><input class="input" id="mx" type="number" min="1" max="1440" value="${r?.max_minutes ?? ''}" placeholder="Vazio = sem limite"></div>
        <div class="field"><label>Cor</label><input class="color-input" id="c" type="color" value="${esc(r?.color || '#f59e0b')}"></div>
      </div>
      <p class="hint" style="margin-top:0">Pausas que passarem do tempo máximo ficam destacadas em vermelho e são contabilizadas como "acima do limite".</p>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Salvar</button></div>
    </form>`);
  m.el.querySelectorAll('[data-close]').forEach((b) => (b.onclick = m.close));
  m.el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: m.el.querySelector('#n').value, maxMinutes: m.el.querySelector('#mx').value, color: m.el.querySelector('#c').value, active: r ? !!r.active : true };
    try {
      await busy(e.submitter, () => api(r ? `/admin/reasons/${r.id}` : '/admin/reasons', { method: r ? 'PUT' : 'POST', body }));
      m.close();
      toast('Motivo salvo.', 'ok');
      await refreshReasons();
      await done();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ---------------- Usuários (admin) ----------------
async function viewUsers(page) {
  setPoll(null);
  let q = '';
  let data = await api('/admin/users');
  const draw = () => {
    const list = data.users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.includes(q));
    page.querySelector('#tb').innerHTML = list.length ? list.map((u) => {
      const ds = deps(u.departments, data.departments);
      return `<tr>
        <td><div class="person"><div class="avatar">${esc(initials(u.name))}</div><div><b>${esc(titleCase(u.name))}</b><span>${esc(u.email)}</span></div></div></td>
        <td>${u.isAgent ? esc(PROFILE[u.profile] || u.profile || '—') : '<span class="pill brand">Conta local</span>'}</td>
        <td>${ds.slice(0, 2).map((d) => `<span class="tag">${esc(d)}</span>`).join('')}${ds.length > 2 ? `<span class="tag" title="${esc(ds.slice(2).join(', '))}">+${ds.length - 2}</span>` : ''}</td>
        <td>${u.registered ? '<span class="pill active">Senha criada</span>' : '<span class="pill offline">Pendente</span>'}</td>
        <td class="num muted">${fmtDateTime(u.lastLoginAt)}</td>
        <td><select class="input" style="width:auto;padding:6px 10px" data-role="${u.id}" ${u.id === S.me.user.id ? 'disabled' : ''}>
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>Usuário</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
        <td><div class="row-actions">${u.registered ? `<button class="btn sm" data-reset="${u.id}">Redefinir senha</button>` : ''}</div></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">Nenhum usuário encontrado.</td></tr>';
    page.querySelector('#count').textContent = `${data.users.length} usuários · ${data.users.filter((u) => u.registered).length} com senha criada · ${data.users.filter((u) => u.role === 'admin').length} admin(s)`;
    page.querySelector('#sync-at').textContent = data.lastSync ? `Última sincronização: ${fmtDateTime(data.lastSync)}` : '';
  };
  page.innerHTML = `
    <div class="page-head"><div><h1>Usuários</h1><p id="count"></p></div>
      <div style="display:flex;gap:10px;align-items:center"><span class="small muted" id="sync-at"></span><button class="btn" id="sync">⟳ Sincronizar com Pulse Direct</button></div></div>
    <div class="card"><div class="toolbar"><input class="input search" id="q" placeholder="Buscar por nome ou e-mail…"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Usuário</th><th>Perfil Pulse Direct</th><th>Equipes</th><th>Primeiro acesso</th><th>Último acesso</th><th>Papel</th><th class="right">Ações</th></tr></thead>
        <tbody id="tb"></tbody></table></div></div>
    <p class="hint">Usuários veem apenas os próprios dados. Admins têm acesso à visão de equipe, relatórios, motivos e usuários. "Redefinir senha" faz o usuário cadastrar uma nova senha no próximo acesso.</p>`;
  draw();
  page.querySelector('#q').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(); });
  page.querySelector('#sync').onclick = async (e) => {
    try {
      const r = await busy(e.currentTarget, () => api('/admin/sync', { method: 'POST' }));
      toast(`Sincronizado: ${r.total} usuários (${r.created} novos).`, 'ok');
      data = await api('/admin/users');
      draw();
    } catch (err) { toast(err.message, 'error'); }
  };
  page.querySelector('#tb').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    try {
      await api(`/admin/users/${sel.dataset.role}/role`, { method: 'PUT', body: { role: sel.value } });
      data.users.find((u) => u.id === Number(sel.dataset.role)).role = sel.value;
      toast('Papel atualizado.', 'ok');
      draw();
    } catch (err) { toast(err.message, 'error'); draw(); }
  });
  page.querySelector('#tb').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-reset]');
    if (!b) return;
    const u = data.users.find((x) => x.id === Number(b.dataset.reset));
    if (!(await confirmDialog('Redefinir senha', `<b>${esc(titleCase(u.name))}</b> precisará criar uma nova senha no próximo acesso, e as sessões abertas serão encerradas.`, 'Redefinir'))) return;
    try {
      await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      u.registered = false;
      toast('Senha redefinida.', 'ok');
      draw();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------- Distribuição automática (só admin: /distribuicao) ----------------
const haQuanto = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now() - ts) / 1000));
  if (s < 60) return `há ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `há ${h} h ${pad(m % 60)} min` : `há ${Math.floor(h / 24)} dias`;
};
const QUEM_DISTRIBUI = {
  sistema: ['brand', 'Distribuição automática'],
  pulse: ['pause', 'Pulse Direct'],
  manual: ['offline', 'Manual'],
  ninguem: ['offline', 'Sem atendente'],
};

async function viewDistribuicao(page) {
  const V = (S.dist ??= { aba: 'atendentes', q: '', dep: '', sit: '', reg: '' });
  V.sel ??= new Set(); // atendentes marcados para ação em massa
  let data = null;
  page.classList.add('wide');
  document.querySelector('.topbar-inner')?.classList.add('wide');
  page.innerHTML = `
    <div class="page-head"><div><h1>Distribuição automática</h1>
      <p>Cada atendente com até <b id="d-teto">15</b> conversas abertas, puxando da fila das equipes dele.</p></div>
      <div class="d-head-actions"><span class="small muted" id="d-atualizado"></span>
        <button class="btn" id="d-config">Configurações</button>
        <button class="btn" id="d-refresh">⟳ Atualizar</button></div></div>
    <div id="d-status"></div>
    <div id="d-avisos"></div>
    <div class="kpis d-kpis section-gap" id="d-kpis"></div>
    <div class="card section-gap">
      <div class="toolbar d-tabs"><div class="seg-ctl" id="d-abas">
        <button data-aba="atendentes">Atendentes</button><button data-aba="equipes">Equipes</button><button data-aba="registro">Registro</button></div></div>
      <div id="d-corpo"><div class="empty"><div class="spinner" style="margin:auto"></div><p>Lendo as conversas no Pulse Direct…</p></div></div>
    </div>
    <p class="hint" id="d-regra"></p>`;

  const drawStatus = () => {
    const d = data;
    page.querySelector('#d-teto').textContent = d.config.teto;
    page.querySelector('#d-atualizado').textContent = d.ultimoCicloOkEm ? `Atualizado ${haQuanto(d.ultimoCicloOkEm)}` : 'Carregando…';
    const ev = d.gatilhos.evento, ag = d.gatilhos.agendador;
    const semGatilho = !ev || now() - ev > 10 * 60_000;
    page.querySelector('#d-status').innerHTML = `
      <div class="card d-status ${d.ligado ? 'on' : 'off'}">
        <div class="d-status-main">
          <div class="state-label"><span class="dot ${d.ligado ? 'live' : ''}"></span>${d.ligado ? 'Ligada' : 'Desligada'}</div>
          <div class="d-status-title">${d.ligado ? 'Distribuindo conversas nas equipes incluídas' : 'Só simulando: nenhuma conversa é atribuída'}</div>
          <div class="muted small">${d.ligado
            ? `${d.resumo.equipesIncluidas} equipe(s) incluída(s). Cada entrega é conferida no Pulse Direct na hora.`
            : `Veja na aba Registro o que o sistema faria. ${d.resumo.equipesIncluidas} equipe(s) incluída(s).`}</div>
        </div>
        <div class="d-status-side">
          <div class="small muted">Gatilho por eventos: <b>${ev ? haQuanto(ev) : 'não configurado'}</b>${ag ? ` · Agendador: <b>${haQuanto(ag)}</b>` : ''}</div>
          ${d.ligado && semGatilho ? '<div class="small" style="color:var(--warn)">Sem eventos recentes: a distribuição só roda com esta tela aberta.</div>' : ''}
          <div class="d-status-btns">
            ${!ev && d.eventosConfiguravel ? '<button class="btn sm" id="d-eventos">Ligar eventos do Pulse Direct</button>' : ''}
            <button class="btn ${d.ligado ? 'danger-ghost' : 'primary'}" id="d-ligar">${d.ligado ? 'Desligar distribuição' : 'Ligar distribuição automática'}</button>
          </div>
        </div>
      </div>`;
    const avisos = [...d.avisos];
    if (d.erros?.seguidos) avisos.unshift(`O último ciclo falhou (${d.erros.seguidos} seguido${d.erros.seguidos > 1 ? 's' : ''}): ${d.erros.ultimo?.mensagem ?? ''}`);
    page.querySelector('#d-avisos').innerHTML = avisos.length
      ? `<div class="d-avisos section-gap">${avisos.map((a) => `<div>${esc(a)}</div>`).join('')}</div>` : '';
    const r = d.resumo;
    const kpi = (label, value, cls = '') => `<div class="kpi card"><div class="label">${label}</div><div class="value num ${cls}">${value}</div></div>`;
    page.querySelector('#d-kpis').innerHTML = !d.leituraCompleta
      ? kpi('Atendentes online', `${r.online}<small class="muted"> de ${r.atendentesEmEquipe}</small>`) + kpi('Conversas', '<small class="muted">lendo…</small>')
      : kpi('Atendentes online', `${r.online}<small class="muted"> de ${r.atendentesEmEquipe}</small>`, 'ok')
        + kpi('Conversas com atendentes', r.abertasComAtendentes)
        + kpi('Esperando nas filas', r.naFila, r.naFila ? 'warn' : '')
        + kpi('Vagas livres (online)', r.vagasLivresOnline)
        + kpi('Online acima do teto', r.onlineAcimaDoTeto, r.onlineAcimaDoTeto ? 'danger' : '')
        + kpi('Concluídos hoje', d.concluidasCarregadas ? r.concluidasHoje : '<small class="muted">carregando…</small>');
    page.querySelector('#d-regra').textContent = `Regra: a conversa mais antiga da fila vai para o atendente online daquela equipe com mais vagas (empate: quem recebeu há mais tempo). `
      + `Contam como abertas as pendentes e as em atendimento, até o atendente finalizar. Ninguém recebe acima de ${d.config.teto}. Só equipes incluídas (aba Equipes › Gerenciar › Configuração) são distribuídas.`;
    page.querySelector('#d-ligar').onclick = (e) => alternar(e.currentTarget);
    page.querySelector('#d-eventos')?.addEventListener('click', async (e) => {
      if (!(await confirmDialog('Ligar eventos do Pulse Direct', 'O Pulse Direct passa a avisar este sistema a cada conversa nova, atualizada ou encerrada. É o que faz a distribuição rodar sem ninguém com esta tela aberta.', 'Ligar eventos'))) return;
      try { await busy(e.currentTarget, () => api('/admin/distribuicao/eventos', { method: 'POST' })); toast('Eventos ligados.', 'ok'); await load(); } catch (err) { toast(err.message, 'error'); }
    });
  };

  const alternar = async (btn) => {
    const ligar = !data.ligado;
    const n = data.resumo.equipesIncluidas;
    const ok = ligar
      ? await confirmDialog('Ligar distribuição automática?', n
        ? `A partir de agora o sistema <b>atribui conversas de verdade</b> no Pulse Direct, nas ${n} equipe(s) incluída(s), até ${data.config.teto} abertas por atendente. Cada entrega é conferida na hora. Para voltar a só simular, é só desligar.`
        : 'Nenhuma equipe está incluída ainda: ligada, ela não entrega nada até você incluir uma equipe (aba Equipes › Gerenciar › Configuração).', 'Ligar distribuição', 'primary')
      : await confirmDialog('Desligar distribuição automática?', 'O sistema para de atribuir conversas e volta a só simular.', 'Desligar', 'primary');
    if (!ok) return;
    try { await busy(btn, () => api('/admin/distribuicao/ligar', { method: 'POST', body: { ligado: ligar } })); toast(ligar ? 'Distribuição ligada.' : 'Distribuição desligada.', 'ok'); await load(); } catch (err) { toast(err.message, 'error'); }
  };

  // ---- aba Atendentes ----
  const opcoesEquipes = (sel = '') => [...data.equipes].sort((a, b) => a.nome.localeCompare(b.nome))
    .map((e) => `<option value="${esc(e.id)}" ${sel === e.id ? 'selected' : ''}>${esc(e.nome)}</option>`).join('');

  const drawAtendentes = (corpo) => {
    const d = data;
    const conhecidos = new Set(d.atendentes.map((a) => a.userId));
    for (const u of V.sel) if (!conhecidos.has(u)) V.sel.delete(u);
    const foco = document.activeElement?.id === 'd-q' ? document.activeElement.selectionStart : null;
    corpo.innerHTML = `
      <div class="toolbar">
        <input class="input search" id="d-q" placeholder="Buscar atendente…" value="${esc(V.q)}">
        <select class="input" id="d-dep"><option value="">Todas as equipes</option>${opcoesEquipes(V.dep)}</select>
        <div class="seg-ctl" id="d-sit">${[['', 'Todos'], ['online', 'Online'], ['acima', 'Acima do teto'], ['vaga', 'Com vaga']].map(([v, l]) => `<button data-v="${v}" class="${V.sit === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <a class="btn" href="/api/admin/distribuicao/atendentes.csv">Exportar planilha</a>
      </div>
      <div class="d-massa hidden" id="d-massa">
        <b id="d-massa-n"></b>
        <select class="input" id="d-massa-eq"><option value="">Escolha a equipe…</option>${opcoesEquipes(V.dep)}</select>
        <button class="btn primary sm" id="d-massa-por">Colocar na equipe</button>
        <button class="btn sm" id="d-massa-tirar">Tirar da equipe</button>
        <button class="btn ghost sm" id="d-massa-limpar">Limpar seleção</button>
      </div>
      <div class="table-wrap"><table class="d-tabela">
        <thead><tr><th class="d-sel"><input type="checkbox" id="d-todos" title="Marcar todos da lista"></th><th>Atendente</th><th>Status</th><th>Abertos por equipe</th><th class="right">Abertos</th><th class="right">Vagas</th><th class="right">Concluídos hoje</th><th class="right">Ações</th></tr></thead>
        <tbody id="d-tb"></tbody></table></div>`;
    const tb = corpo.querySelector('#d-tb');
    let visiveis = [];
    const barra = () => {
      const n = V.sel.size;
      corpo.querySelector('#d-massa').classList.toggle('hidden', !n);
      corpo.querySelector('#d-massa-n').textContent = `${n} selecionado${n > 1 ? 's' : ''}`;
      const todos = corpo.querySelector('#d-todos');
      const marcados = visiveis.filter((a) => V.sel.has(a.userId)).length;
      todos.checked = visiveis.length > 0 && marcados === visiveis.length;
      todos.indeterminate = marcados > 0 && marcados < visiveis.length;
    };
    const linhas = () => {
      const q = V.q.toLowerCase();
      visiveis = d.atendentes.filter((a) => (!q || a.nome.toLowerCase().includes(q) || (a.email || '').includes(q))
        && (!V.dep || a.equipes.some((e) => e.id === V.dep))
        && (V.sit !== 'online' || a.online) && (V.sit !== 'acima' || a.abertas > d.config.teto) && (V.sit !== 'vaga' || (a.online && a.vagas > 0)))
        .sort((a, b) => b.abertas - a.abertas || a.nome.localeCompare(b.nome));
      tb.innerHTML = visiveis.length ? visiveis.map((a) => {
        const pctv = Math.min(100, (a.abertas / d.config.teto) * 100);
        const cls = a.abertas > d.config.teto ? 'over' : a.abertas === d.config.teto ? 'full' : '';
        const porEquipe = a.porEquipe.length ? a.porEquipe.map((e) => `<span class="tag ${e.membro ? '' : 'd-fora'}" title="${e.membro ? '' : 'Conversas de uma equipe da qual a pessoa não é atendente'}">${esc(e.nome)} · <b>${e.n}</b></span>`).join('') : '<span class="muted small">—</span>';
        const equipes = a.equipes.length
          ? a.equipes.map((e) => `<button class="d-chip ${V.dep === e.id ? 'on' : ''}" data-filtro="${esc(e.id)}" title="Ver só esta equipe">${esc(e.nome)}</button>`).join('')
          : '<span class="muted small">Sem equipe</span>';
        return `<tr class="${V.sel.has(a.userId) ? 'd-marcado' : ''}">
          <td class="d-sel"><input type="checkbox" data-sel="${esc(a.userId)}" ${V.sel.has(a.userId) ? 'checked' : ''}></td>
          <td><div class="person"><div class="avatar">${esc(initials(a.nome))}</div><div><b>${esc(titleCase(a.nome))}</b><div class="d-chips">${equipes}</div></div></div></td>
          <td>${a.online ? '<span class="pill active"><span class="dot"></span>Online</span>' : '<span class="pill offline"><span class="dot"></span>Offline</span>'}</td>
          <td class="d-equipes">${porEquipe}</td>
          <td class="right"><div class="d-carga ${cls}"><div class="d-bar"><i style="width:${pctv}%"></i></div><b class="num">${a.abertas}</b></div>
            <div class="small muted num">${a.pendentes} pend. · ${a.emAtendimento} em atend.</div></td>
          <td class="right num">${a.vagas}</td>
          <td class="right num">${d.concluidasCarregadas ? a.concluidasHoje : '<span class="muted">…</span>'}</td>
          <td><div class="row-actions"><button class="btn sm" data-equipes="${esc(a.userId)}">Editar equipes</button></div></td></tr>`;
      }).join('') : '<tr><td colspan="8" class="empty">Nenhum atendente encontrado.</td></tr>';
      barra();
    };
    linhas();
    const busca = corpo.querySelector('#d-q');
    if (foco !== null) { busca.focus(); busca.setSelectionRange(foco, foco); }
    busca.addEventListener('input', (e) => { V.q = e.target.value; linhas(); });
    const filtrarEquipe = (id) => {
      V.dep = id;
      corpo.querySelector('#d-dep').value = id;
      if (id) corpo.querySelector('#d-massa-eq').value = id;
      linhas();
    };
    corpo.querySelector('#d-dep').addEventListener('change', (e) => filtrarEquipe(e.target.value));
    corpo.querySelectorAll('#d-sit button').forEach((b) => b.addEventListener('click', () => {
      V.sit = b.dataset.v;
      corpo.querySelectorAll('#d-sit button').forEach((x) => x.classList.toggle('on', x === b));
      linhas();
    }));
    corpo.querySelector('#d-todos').addEventListener('change', (e) => {
      for (const a of visiveis) e.target.checked ? V.sel.add(a.userId) : V.sel.delete(a.userId);
      linhas();
    });
    tb.addEventListener('change', (e) => {
      const c = e.target.closest('[data-sel]');
      if (!c) return;
      c.checked ? V.sel.add(c.dataset.sel) : V.sel.delete(c.dataset.sel);
      c.closest('tr').classList.toggle('d-marcado', c.checked);
      barra();
    });
    tb.addEventListener('click', (e) => {
      const f = e.target.closest('[data-filtro]');
      if (f) return filtrarEquipe(V.dep === f.dataset.filtro ? '' : f.dataset.filtro);
      const b = e.target.closest('[data-equipes]');
      if (b) equipesDoAtendente(d.atendentes.find((a) => a.userId === b.dataset.equipes));
    });
    corpo.querySelector('#d-massa-limpar').onclick = () => { V.sel.clear(); linhas(); };
    const emMassa = async (btn, colocar) => {
      const equipeId = corpo.querySelector('#d-massa-eq').value;
      if (!equipeId) return toast('Escolha a equipe primeiro.', 'error');
      const equipe = d.equipes.find((e) => e.id === equipeId);
      const pessoas = d.atendentes.filter((a) => V.sel.has(a.userId));
      // só quem precisa mudar: colocar quem ainda não está, tirar quem está
      const alvo = pessoas.filter((a) => a.equipes.some((e) => e.id === equipeId) !== colocar);
      if (!alvo.length) return toast(colocar ? `Todos os selecionados já estão em ${equipe.nome}.` : `Nenhum dos selecionados está em ${equipe.nome}.`, 'error');
      const nomes = alvo.map((a) => esc(titleCase(a.nome)));
      const texto = `${colocar ? 'Colocar' : 'Tirar'} <b>${alvo.length}</b> pessoa(s) ${colocar ? 'em' : 'de'} <b>${esc(equipe.nome)}</b>:<br>${nomes.slice(0, 12).join(', ')}${nomes.length > 12 ? ` e mais ${nomes.length - 12}` : ''}.`
        + (colocar ? '' : '<br><br>As conversas abertas continuam com cada pessoa.');
      if (!(await confirmDialog(colocar ? 'Colocar na equipe?' : 'Tirar da equipe?', texto, 'Confirmar'))) return;
      const ids = alvo.map((a) => a.userId);
      try {
        const r = await busy(btn, () => api(`/admin/distribuicao/equipes/${encodeURIComponent(equipeId)}/membros`, { method: 'PUT', body: colocar ? { adicionar: ids } : { remover: ids } }));
        if (r.falhas?.length) toast(`Parte não foi aplicada: ${r.falhas.join('; ')}`, 'error');
        else toast(`${equipe.nome}: ${alvo.length} pessoa(s) ${colocar ? 'colocada(s)' : 'tirada(s)'}.`, 'ok');
        V.sel.clear();
        await load();
      } catch (err) { toast(err.message, 'error'); }
    };
    corpo.querySelector('#d-massa-por').onclick = (e) => emMassa(e.currentTarget, true);
    corpo.querySelector('#d-massa-tirar').onclick = (e) => emMassa(e.currentTarget, false);
  };

  const equipesDoAtendente = (a) => {
    const atuais = new Set(a.equipes.map((e) => e.id));
    const abertasPorEquipe = new Map(a.porEquipe.map((e) => [e.id, e.n]));
    const equipes = [...data.equipes].sort((x, y) => Number(atuais.has(y.id)) - Number(atuais.has(x.id)) || x.nome.localeCompare(y.nome));
    const m = modal(`
      <div class="modal-head"><div><h2>Equipes de ${esc(titleCase(a.nome))}</h2><p class="muted small" style="margin:4px 0 0">Marque as equipes em que a pessoa atende. Para trocar de equipe, desmarque a atual e marque a nova.</p></div><button class="btn ghost sm" data-close>✕</button></div>
      <input class="input" id="d-fq" placeholder="Buscar equipe…" style="margin-bottom:10px">
      <div class="d-check-list">${equipes.map((e) => `
        <label class="d-check" data-nome="${esc(e.nome.toLowerCase())}"><input type="checkbox" value="${esc(e.id)}" ${atuais.has(e.id) ? 'checked' : ''}>
          <span>${esc(e.nome)}</span>${abertasPorEquipe.get(e.id) ? `<span class="tag">${abertasPorEquipe.get(e.id)} abertas</span>` : ''}</label>`).join('')}</div>
      <p class="hint" style="margin-top:12px">As conversas abertas continuam com a pessoa mesmo se ela sair da equipe. A mudança vale no Pulse Direct na hora.</p>
      <div class="modal-foot"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="d-salvar">Salvar</button></div>`);
    m.el.querySelector('#d-fq').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      m.el.querySelectorAll('.d-check').forEach((l) => l.classList.toggle('hidden', q && !l.dataset.nome.includes(q)));
    });
    m.el.querySelector('#d-salvar').onclick = async (e) => {
      const marcadas = new Set([...m.el.querySelectorAll('.d-check input:checked')].map((i) => i.value));
      const adicionar = [...marcadas].filter((id) => !atuais.has(id));
      const remover = [...atuais].filter((id) => !marcadas.has(id));
      if (!adicionar.length && !remover.length) return m.close();
      const nome = (id) => data.equipes.find((x) => x.id === id)?.nome ?? id;
      const texto = [remover.length ? `Tirar de: <b>${remover.map((id) => esc(nome(id))).join(', ')}</b>` : '', adicionar.length ? `Colocar em: <b>${adicionar.map((id) => esc(nome(id))).join(', ')}</b>` : ''].filter(Boolean).join('<br>');
      if (!(await confirmDialog(`Mudar equipes de ${titleCase(a.nome)}?`, texto, 'Confirmar'))) return;
      try {
        const r = await busy(e.currentTarget, () => api(`/admin/distribuicao/atendentes/${encodeURIComponent(a.userId)}/equipes`, { method: 'PUT', body: { adicionar, remover } }));
        m.close();
        if (r.falhas?.length) toast(`Parte não foi aplicada: ${r.falhas.join('; ')}`, 'error');
        else toast('Equipes atualizadas no Pulse Direct.', 'ok');
        await load();
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ---- aba Equipes ----
  const drawEquipes = (corpo) => {
    const d = data;
    const ordem = { sistema: 0, pulse: 1, manual: 2, ninguem: 3 };
    const lista = [...d.equipes].sort((a, b) => Boolean(b.alerta) - Boolean(a.alerta) || b.aguardando - a.aguardando || ordem[a.quemDistribui] - ordem[b.quemDistribui] || a.nome.localeCompare(b.nome));
    corpo.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Equipe</th><th>Quem distribui</th><th class="right">Na fila</th><th class="right">Mais antiga</th><th class="right">Online</th><th class="right">Vagas livres</th><th>Alerta</th><th class="right">Ações</th></tr></thead>
      <tbody>${lista.map((e) => {
        const [cls, rotulo] = QUEM_DISTRIBUI[e.quemDistribui];
        return `<tr>
          <td><b>${esc(e.nome)}</b>${e.incluida && e.distribuicaoNativa ? '<div class="small" style="color:var(--warn)">Incluída, mas o Pulse Direct ainda distribui</div>' : ''}</td>
          <td><span class="pill ${cls}">${rotulo}</span></td>
          <td class="right num"><b>${e.aguardando}</b></td>
          <td class="right num">${e.maisAntigaEm ? haQuanto(e.maisAntigaEm).replace('há ', '') : '—'}</td>
          <td class="right num">${e.online}/${e.atendentes}</td>
          <td class="right num">${e.vagasLivres}</td>
          <td>${e.alerta ? `<span class="pill over">${esc(e.alerta)}</span>` : ''}</td>
          <td><div class="row-actions"><button class="btn sm" data-equipe="${esc(e.id)}">Gerenciar</button></div></td></tr>`;
      }).join('')}</tbody></table></div>`;
    corpo.querySelector('tbody').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr');
      const b = ev.target.closest('[data-equipe]') ?? tr?.querySelector('[data-equipe]');
      if (b) gerenciarEquipe(d.equipes.find((x) => x.id === b.dataset.equipe));
    });
  };

  /** Painel da equipe: quem está nela (tirar / colocar várias pessoas de uma vez) e configuração. */
  const gerenciarEquipe = (e, aba = 'pessoas') => {
    const membros = data.atendentes.filter((a) => a.equipes.some((x) => x.id === e.id));
    const idsMembros = new Set(membros.map((a) => a.userId));
    const porId = new Map(data.atendentes.map((a) => [a.userId, a]));
    const outros = data.usuarios.filter((u) => !idsMembros.has(u.userId)).sort((a, b) => Number(b.online) - Number(a.online) || a.nome.localeCompare(b.nome));
    const tirar = new Set(), colocar = new Set();
    const linhaPessoa = (u, modo) => {
      const a = porId.get(u.userId);
      const outras = (a?.equipes ?? []).filter((x) => x.id !== e.id).map((x) => x.nome);
      const marcado = modo === 'membro' ? tirar.has(u.userId) : colocar.has(u.userId);
      return `<div class="d-pessoa ${marcado ? (modo === 'membro' ? 'saindo' : 'entrando') : ''}" data-nome="${esc(`${u.nome} ${u.email ?? ''}`.toLowerCase())}">
        <span class="dot-status ${u.online ? 'on' : ''}" title="${u.online ? 'Online' : 'Offline'}"></span>
        <div class="d-pessoa-info"><b>${esc(titleCase(u.nome))}</b><span>${modo === 'membro'
          ? `${a?.abertas ?? 0} abertas${outras.length ? ` · também em ${esc(outras.join(', '))}` : ''}`
          : esc(outras.join(', ') || 'Sem equipe')}</span></div>
        <button type="button" class="btn sm ${modo === 'membro' ? (marcado ? '' : 'danger-ghost') : (marcado ? '' : 'primary')}" data-${modo}="${esc(u.userId)}">${modo === 'membro' ? (marcado ? 'Desfazer' : 'Tirar') : (marcado ? 'Desfazer' : 'Colocar')}</button></div>`;
    };
    const m = modal(`
      <div class="modal-head"><div><h2>${esc(e.nome)}</h2><p class="muted small" style="margin:4px 0 0">${e.atendentes} atendente(s) · ${e.online} online · ${e.aguardando} na fila · ${QUEM_DISTRIBUI[e.quemDistribui][1]}</p></div><button class="btn ghost sm" data-close>✕</button></div>
      <div class="seg-ctl" id="g-abas" style="margin-bottom:14px"><button data-g="pessoas">Pessoas</button><button data-g="config">Configuração</button></div>
      <div id="g-pessoas">
        <div class="d-colunas">
          <div><div class="d-col-head"><b>Na equipe (${membros.length})</b><input class="input sm" id="g-qm" placeholder="Filtrar…"></div>
            <div class="d-lista" id="g-membros">${membros.length ? '' : '<div class="empty small">Ninguém nesta equipe.</div>'}</div></div>
          <div><div class="d-col-head"><b>Colocar pessoas</b><input class="input sm" id="g-qo" placeholder="Buscar pessoa…"></div>
            <div class="d-lista" id="g-outros"></div></div>
        </div>
        <p class="hint" style="margin-top:12px">Quem sai continua com as conversas abertas. As mudanças valem no Pulse Direct ao salvar.</p>
        <div class="modal-foot"><span class="small muted" id="g-resumo" style="margin-right:auto"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="g-salvar" disabled>Salvar mudanças</button></div>
      </div>
      <form id="f" class="hidden">
        <div class="field"><label for="d-nome">Nome</label><input class="input" id="d-nome" maxlength="80" value="${esc(e.nome)}" required></div>
        <label class="d-switch-row"><input type="checkbox" id="d-incluir" ${e.incluida ? 'checked' : ''}><span class="d-switch"></span>
          <span><b>Incluir na distribuição automática</b><span class="hint">Com a distribuição ligada, o sistema entrega as conversas da fila desta equipe.</span></span></label>
        <label class="d-switch-row"><input type="checkbox" id="d-nativa" ${e.distribuicaoNativa ? 'checked' : ''}><span class="d-switch"></span>
          <span><b>Distribuição do próprio Pulse Direct</b><span class="hint">Precisa estar desligada para o sistema assumir a equipe (as duas juntas disputariam a fila).</span></span></label>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Salvar</button></div>
      </form>`, { wide: true });

    const trocarAba = (g) => {
      m.el.querySelectorAll('#g-abas button').forEach((b) => b.classList.toggle('on', b.dataset.g === g));
      m.el.querySelector('#g-pessoas').classList.toggle('hidden', g !== 'pessoas');
      m.el.querySelector('#f').classList.toggle('hidden', g !== 'config');
    };
    m.el.querySelectorAll('#g-abas button').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.g)));
    trocarAba(aba);

    const filtrar = (lista, q) => lista.querySelectorAll('.d-pessoa').forEach((l) => l.classList.toggle('hidden', Boolean(q) && !l.dataset.nome.includes(q)));
    const desenharPessoas = () => {
      const lm = m.el.querySelector('#g-membros'), lo = m.el.querySelector('#g-outros');
      if (membros.length) lm.innerHTML = membros.map((a) => linhaPessoa(a, 'membro')).join('');
      lo.innerHTML = outros.length ? outros.map((u) => linhaPessoa(u, 'outro')).join('') : '<div class="empty small">Todos os usuários já estão nesta equipe.</div>';
      filtrar(lm, m.el.querySelector('#g-qm').value.toLowerCase());
      filtrar(lo, m.el.querySelector('#g-qo').value.toLowerCase());
      const partes = [colocar.size ? `colocar ${colocar.size}` : '', tirar.size ? `tirar ${tirar.size}` : ''].filter(Boolean);
      m.el.querySelector('#g-resumo').textContent = partes.length ? `Ao salvar: ${partes.join(' e ')}.` : '';
      m.el.querySelector('#g-salvar').disabled = !partes.length;
    };
    desenharPessoas();
    m.el.querySelector('#g-qm').addEventListener('input', (ev) => filtrar(m.el.querySelector('#g-membros'), ev.target.value.toLowerCase()));
    m.el.querySelector('#g-qo').addEventListener('input', (ev) => filtrar(m.el.querySelector('#g-outros'), ev.target.value.toLowerCase()));
    m.el.querySelector('#g-pessoas').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-membro], [data-outro]');
      if (!b) return;
      const [conj, id] = b.dataset.membro ? [tirar, b.dataset.membro] : [colocar, b.dataset.outro];
      conj.has(id) ? conj.delete(id) : conj.add(id);
      desenharPessoas();
    });
    m.el.querySelector('#g-salvar').onclick = async (ev) => {
      const nome = (id) => esc(titleCase((data.usuarios.find((u) => u.userId === id) ?? porId.get(id))?.nome ?? id));
      const texto = [colocar.size ? `Colocar: <b>${[...colocar].map(nome).join(', ')}</b>` : '', tirar.size ? `Tirar: <b>${[...tirar].map(nome).join(', ')}</b>` : ''].filter(Boolean).join('<br>');
      if (!(await confirmDialog(`Mudar as pessoas de ${e.nome}?`, texto, 'Confirmar'))) return;
      try {
        const r = await busy(ev.currentTarget, () => api(`/admin/distribuicao/equipes/${encodeURIComponent(e.id)}/membros`, { method: 'PUT', body: { adicionar: [...colocar], remover: [...tirar] } }));
        m.close();
        if (r.falhas?.length) toast(`Parte não foi aplicada: ${r.falhas.join('; ')}`, 'error');
        else toast(`${e.nome}: equipe atualizada no Pulse Direct.`, 'ok');
        await load();
      } catch (err) { toast(err.message, 'error'); }
    };

    m.el.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const body = { nome: m.el.querySelector('#d-nome').value, incluir: m.el.querySelector('#d-incluir').checked, distribuicaoNativa: m.el.querySelector('#d-nativa').checked };
      if (body.distribuicaoNativa !== e.distribuicaoNativa
        && !(await confirmDialog(`${body.distribuicaoNativa ? 'Ligar' : 'Desligar'} a distribuição do Pulse Direct?`, `Isso muda a configuração da equipe <b>${esc(e.nome)}</b> no próprio Pulse Direct, na hora.`, 'Confirmar'))) return;
      try {
        await busy(ev.submitter, () => api(`/admin/distribuicao/equipes/${encodeURIComponent(e.id)}`, { method: 'PUT', body }));
        m.close();
        toast('Equipe atualizada.', 'ok');
        await load();
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  // ---- aba Registro ----
  const NOMES_CAT = { pessoas: 'Pessoas e equipes', decisoes: 'Decisão', sistema: 'Sistema' };
  const drawRegistro = async (corpo) => {
    corpo.innerHTML = `
      <div class="toolbar"><div class="seg-ctl" id="d-cat">${[['', 'Tudo'], ['pessoas', 'Pessoas e equipes'], ['decisoes', 'Decisões'], ['erros', 'Avisos e erros'], ['sistema', 'Sistema']].map(([v, l]) => `<button data-v="${v}" class="${V.reg === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div id="d-reg" class="d-log"><div class="empty"><div class="spinner" style="margin:auto"></div></div></div>`;
    const carregar = async () => {
      const itens = await api(`/admin/distribuicao/registro?limite=300${V.reg ? `&categoria=${V.reg}` : ''}`);
      const hoje = new Date().toDateString();
      const alvo = corpo.querySelector('#d-reg');
      if (!alvo) return;
      alvo.innerHTML = itens.length ? itens.map((i) => {
        const dt = new Date(i.em);
        const quando = dt.toDateString() === hoje ? dt.toLocaleTimeString('pt-BR') : fmtDateTime(i.em);
        return `<div class="d-log-item ${esc(i.nivel)}"><span class="num muted small">${quando}</span><div><div>${esc(i.mensagem)}</div><div class="small muted">${NOMES_CAT[i.categoria] || esc(i.categoria)}</div></div></div>`;
      }).join('') : '<div class="empty">Nada registrado nesta categoria ainda.</div>';
    };
    corpo.querySelectorAll('#d-cat button').forEach((b) => b.addEventListener('click', () => {
      V.reg = b.dataset.v;
      corpo.querySelectorAll('#d-cat button').forEach((x) => x.classList.toggle('on', x === b));
      carregar().catch((err) => toast(err.message, 'error'));
    }));
    await carregar();
  };

  const drawCorpo = async () => {
    page.querySelectorAll('#d-abas button').forEach((b) => b.classList.toggle('on', b.dataset.aba === V.aba));
    const corpo = page.querySelector('#d-corpo');
    if (V.aba === 'equipes') drawEquipes(corpo);
    else if (V.aba === 'registro') await drawRegistro(corpo);
    else drawAtendentes(corpo);
  };

  const configModal = () => {
    const c = data.config;
    const m = modal(`
      <div class="modal-head"><h2>Configurações</h2><button class="btn ghost sm" data-close>✕</button></div>
      <form id="f">
        <div class="field"><label for="c-teto">Teto de conversas abertas por atendente</label><input class="input" id="c-teto" type="number" min="1" max="200" value="${c.teto}" required>
          <span class="hint">Pendentes + em atendimento, até o atendente finalizar.</span></div>
        <div class="field"><label for="c-max">Máximo de conversas por atendente a cada ciclo</label><input class="input" id="c-max" type="number" min="1" max="50" value="${c.maxPorCiclo}" required>
          <span class="hint">Evita despejar muitas conversas de uma vez em quem acabou de ficar online.</span></div>
        <div class="field"><label for="c-alerta">Alertar fila esperando há mais de (minutos)</label><input class="input" id="c-alerta" type="number" min="1" max="1440" value="${c.alertaFilaMin}" required></div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Salvar</button></div>
      </form>`);
    m.el.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const body = { teto: Number(m.el.querySelector('#c-teto').value), maxPorCiclo: Number(m.el.querySelector('#c-max').value), alertaFilaMin: Number(m.el.querySelector('#c-alerta').value) };
      try { await busy(ev.submitter, () => api('/admin/distribuicao/config', { method: 'PUT', body })); m.close(); toast('Configurações salvas.', 'ok'); await load(); } catch (err) { toast(err.message, 'error'); }
    };
  };

  const load = async () => {
    try {
      data = await api('/admin/distribuicao');
    } catch (err) {
      page.querySelector('#d-corpo').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      throw err;
    }
    drawStatus();
    if (V.aba !== 'registro' || !page.querySelector('#d-reg')) await drawCorpo();
  };

  page.querySelectorAll('#d-abas button').forEach((b) => b.addEventListener('click', () => { V.aba = b.dataset.aba; if (data) drawCorpo().catch((err) => toast(err.message, 'error')); }));
  page.querySelector('#d-refresh').onclick = async (e) => {
    try { await busy(e.currentTarget, async () => { await api('/admin/distribuicao/atualizar', { method: 'POST' }); await load(); }); } catch (err) { toast(err.message, 'error'); }
  };
  page.querySelector('#d-config').onclick = () => data && configModal();

  await load();
  setPoll(() => load().catch(() => {}), 20000);
}

// ---------------- Roteamento ----------------
const ROUTES = { '/': viewMe, '/equipe': viewTeam, '/relatorios': viewReports, '/motivos': viewReasons, '/usuarios': viewUsers, '/distribuicao': viewDistribuicao };
// abas de gestão: só admin
const ADMIN_ONLY = new Set(['/equipe', '/relatorios', '/motivos', '/usuarios', '/distribuicao']);

async function route() {
  if (!S.me) return;
  let path = location.hash.replace(/^#/, '') || '/';
  if (!ROUTES[path] || (ADMIN_ONLY.has(path) && S.me.user.role !== 'admin')) path = '/';
  if (path === '/' && !S.me.user.isAgent && S.me.user.role === 'admin') path = '/equipe';
  setPoll(null);
  const page = shell(path);
  try {
    await ROUTES[path](page);
  } catch (e) {
    if (S.me) page.innerHTML = `<div class="card card-pad empty">${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">Tentar novamente</button></div>`;
  }
}
window.addEventListener('hashchange', route);

// Endereço direto: gestaodepausa…/distribuicao → rota interna #/distribuicao
if (/^\/distribui(c|%C3%A7|ç)(a|%C3%A3|ã)o\/?$/i.test(location.pathname)) history.replaceState(null, '', '/#/distribuicao');

async function boot() {
  try {
    S.me = await api('/me');
    S.offset = S.me.serverNow - Date.now();
    route();
  } catch {
    if (!S.me) renderLogin();
  }
}
boot();
