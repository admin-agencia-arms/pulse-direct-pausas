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
    ...(isAdmin ? [['/equipe', 'Equipe'], ['/relatorios', 'Relatórios'], ['/motivos', 'Motivos de pausa'], ['/usuarios', 'Usuários']] : []),
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

// ---------------- Roteamento ----------------
const ROUTES = { '/': viewMe, '/equipe': viewTeam, '/relatorios': viewReports, '/motivos': viewReasons, '/usuarios': viewUsers };
const ADMIN_ONLY = new Set(['/equipe', '/relatorios', '/motivos', '/usuarios']);

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
