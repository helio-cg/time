// Controlador da PWA: roteamento, renderização e ações.
// Toda ação vira uma operação de domínio aplicada localmente (offline-first)
// e enfileirada para sincronização.

import {
  applyOp,
  activePool,
  canCreateMatch,
  canRevertMatch,
  createEventState,
  getCurrentMatch,
  getReigningTeam,
  requiredPlayersToCreate,
  isFinalized,
  matchHistory,
  topScorers,
  uid,
  nowIso,
} from './domain.js';
import * as store from './store.js';
import * as sync from './sync.js';

const app = {
  identity: { owner_id: '', name: '', phone: '' },
  events: [],
  eventId: null,
  state: null,
  route: { name: 'home' },
};

// Estado de interação: durante um arraste/digitação adiamos o render para não
// destruir a lista ou o campo em foco no meio do gesto.
let draggingPool = false;
let renderQueuedWhileDragging = false;
let pendingRender = false;

// Pode editar quando: é o dono, OU o racha ainda não tem dono (rachas criados
// antes do controle de propriedade). Continua bloqueado em racha de outra pessoa.
function canEdit(evOrState) {
  if (!evOrState) return false;
  const ev = evOrState.event || evOrState;
  return Boolean(ev.is_owner) || !ev.owner_name;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : esc(value || '');
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  return (name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function ballIcon(size = 20, color = '#f97316') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="${color}" stroke-width="2"/>
    <path d="M12 7l2.4 1.8-.9 2.8h-3l-.9-2.8L12 7zM6.2 9.6l2.6.5M17.8 9.6l-2.6.5M9 18l1.5-2.6M15 18l-1.5-2.6" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function clearAndFocus(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.value = '';
  el.focus({ preventScroll: true });
  try {
    el.setSelectionRange(0, 0);
  } catch {
    // ignora inputs sem suporte a seleção
  }
}

function toast(message, type = '') {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${type ? ` toast--${type}` : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

function openModal({ title, body, foot = '', onMount }) {
  const root = document.getElementById('modal');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal__backdrop" data-act="close-modal"></div>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal__head">
        <div class="between">
          <h3 style="margin:0;font-size:15px;font-weight:800">${title}</h3>
          <button class="icon-btn" data-act="close-modal" aria-label="Fechar">✕</button>
        </div>
      </div>
      <div class="modal__body">${body}</div>
      ${foot ? `<div class="modal__foot">${foot}</div>` : ''}
    </div>`;
  if (onMount) onMount();
}

function closeModal() {
  const root = document.getElementById('modal');
  root.hidden = true;
  root.innerHTML = '';
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function renderTopbar() {
  const el = document.getElementById('topbar');
  const { online, pending, syncing, error } = sync.status;

  let pillClass = online ? 'pill--online' : 'pill--offline';
  let pillLabel = online ? 'Online' : 'Offline';
  if (error) {
    pillClass = 'pill--error';
    pillLabel = 'Erro';
  } else if (online && pending > 0) {
    pillClass = 'pill--sync';
    pillLabel = `Pendentes ${pending}`;
  }
  const indicator = syncing ? '<span class="spin"></span>' : '<span class="dot"></span>';

  const showHome = app.route.name !== 'home';

  el.innerHTML = `
    <div class="topbar__brand">
      ${
        showHome
          ? `<button class="home-btn" data-act="nav-home" title="Início" aria-label="Início">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 10.5 12 4l8 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M10 20v-5h4v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>`
          : `<div class="topbar__logo">${ballIcon(18, '#f97316')}</div>`
      }
      <div style="min-width:0">
        <div class="topbar__title">Racha Times</div>
        <div class="topbar__sub">${esc(app.state?.event?.title || 'Montar times')}</div>
      </div>
    </div>
    <div class="topbar__actions">
      <button class="pill ${pillClass}" data-act="toggle-sync" title="Toque para sincronizar">
        ${indicator}${esc(pillLabel)}
      </button>
      <button class="pill pill--sync" data-act="identity" title="Seu nome">${esc(initials(app.identity.name) || '?')}</button>
    </div>`;
}

function homeView() {
  const events = app.events || [];
  const offline = !sync.status.online;
  const active = events.filter((ev) => !ev.finalized_at);
  const past = events.filter((ev) => ev.finalized_at);

  const activeSection = active.length
    ? `<div class="stack">${active.map((ev) => activeEventCard(ev)).join('')}</div>`
    : `<div class="card"><div class="empty"><span class="empty__icon">📅</span>Nenhum racha em aberto.<br>Crie um novo para montar os times.</div></div>`;

  const pastSection = past.length
    ? `<div class="stack" style="gap:10px">
        <h2 class="card__title" style="margin:2px 0 0">Anteriores</h2>
        ${past.map((ev) => pastEventCard(ev)).join('')}
      </div>`
    : '';

  return `
    <div class="hero">
      <div class="hero__row">
        <div class="hero__icon">${ballIcon(24, '#fff')}</div>
        <div>
          <h1 class="hero__title">Montar Times</h1>
          <p class="hero__sub">Funciona offline e sincroniza sozinho</p>
        </div>
      </div>
    </div>
    ${offline ? `<div class="card" style="border-color:#fde68a;background:#fffbeb"><p class="muted" style="margin:0;color:#92400e">Você está offline. Pode usar normalmente — enviamos quando a internet voltar.</p></div>` : ''}
    <button class="btn btn--orange" data-act="new-event">+ Novo racha</button>
    ${
      hasOrphanEvents()
        ? `<button class="btn btn--ghost" data-act="claim-events">Estes rachas são meus (reivindicar)</button>`
        : ''
    }
    ${activeSection}
    ${pastSection}
    <p class="muted" style="text-align:center">${sync.status.pending ? `${sync.status.pending} operação(ões) pendente(s)` : 'Tudo sincronizado'}</p>`;
}

function activeEventCard(ev) {
  const ownerBadge = canEdit(ev)
    ? `<span class="pill" style="background:var(--green-50);color:var(--green-700)">Seu racha</span>`
    : ev.owner_name
      ? `<span class="pill pill--offline">${esc(ev.owner_name)}</span>`
      : '';
  return `<button class="event-item event-item--active" data-act="open-pool" data-id="${esc(ev.id)}">
    <div style="min-width:0;width:100%">
      <div class="between" style="gap:8px">
        <p class="event-item__title" style="font-size:17px">${esc(ev.title)}</p>
        ${ownerBadge}
      </div>
      <p class="event-item__meta">${formatDate(ev.event_date)}${ev.location ? ` · ${esc(ev.location)}` : ''}</p>
      <p class="muted" style="margin:8px 0 0">${canEdit(ev) ? 'Toque para montar os times (você pode editar)' : 'Toque para visualizar'}</p>
    </div>
    <span class="chev">›</span>
  </button>`;
}

function hasOrphanEvents() {
  return (app.events || []).some((ev) => !ev.owner_name);
}

function pastEventCard(ev) {
  return `<button class="event-item event-item--past" data-act="open-pool" data-id="${esc(ev.id)}">
    <div style="min-width:0">
      <p class="event-item__title" style="font-size:14px">${esc(ev.title)}</p>
      <p class="event-item__meta">${formatDate(ev.event_date)}${ev.location ? ` · ${esc(ev.location)}` : ''}</p>
    </div>
    <span class="pill pill--offline">Finalizado</span>
  </button>`;
}

function poolView() {
  const state = app.state;
  const event = state.event || {};
  const pool = activePool(state);
  const current = getCurrentMatch(state);
  const reigning = getReigningTeam(state);
  const history = matchHistory(state);
  const owner = canEdit(state);
  const finalized = isFinalized(state);

  const ownerBanner = owner
    ? ''
    : `<div class="card" style="border-color:#bfdbfe;background:#eff6ff">
        <p style="margin:0;font-size:13px;color:#1e40af;font-weight:700">Somente visualização</p>
        <p class="muted" style="margin:4px 0 0;color:#1e3a8a">Este racha foi criado por ${esc(event.owner_name || 'outra pessoa')}. Você pode acompanhar, mas não alterar.</p>
      </div>`;

  const finalizeButton = owner
    ? finalized
      ? `<button class="btn btn--ghost" data-act="reopen-event">Reabrir racha</button>`
      : `<button class="btn btn--black" data-act="finalize-event">Finalizar racha</button>`
    : '';

  return `
    <button class="back" data-act="nav-home">‹ Voltar</button>
    <div class="hero">
      <div class="between">
        <div style="min-width:0">
          <p class="hero__sub" style="margin:0;text-transform:uppercase;font-size:11px;letter-spacing:.5px">Montar Times</p>
          <h1 class="hero__title">${esc(event.title || 'Racha')}</h1>
          <p class="hero__sub">${formatDate(event.event_date)}${event.location ? ` · ${esc(event.location)}` : ''}</p>
        </div>
        <button class="btn btn--sm" style="background:rgba(255,255,255,.15);color:#fff" data-act="open-scorers">⚽ Artilheiros</button>
      </div>
    </div>
    ${finalized ? finalizedCard(state) : ''}
    ${ownerBanner}
    ${current && !finalized ? currentMatchCard(current) : ''}
    ${reigning && !finalized ? reigningCard(reigning) : ''}
    ${owner && !finalized && !current ? createMatchButton(pool.length, canCreateMatch(state), requiredPlayersToCreate(state), Boolean(reigning)) : ''}
    ${owner && !finalized ? addPlayerCard() : ''}
    ${!finalized ? queueCard(pool, owner && !finalized) : ''}
    ${!finalized ? withdrawnCard(state.withdrawn, owner && !finalized) : ''}
    ${history.length ? historyCard(history) : ''}
    ${finalizeButton}`;
}

function finalizedCard(state) {
  const history = matchHistory(state);
  const scorers = topScorers(state);
  const top = scorers[0];
  return `<div class="hero hero--green">
    <div class="hero__row">
      <div class="hero__icon"><span style="font-size:22px">🏁</span></div>
      <div>
        <h2 class="hero__title" style="font-size:16px">Racha finalizado</h2>
        <p class="hero__sub">${history.length} partida(s)${top ? ` · artilheiro: ${esc(top.player_name)} (${top.total_goals})` : ''}</p>
      </div>
    </div>
  </div>`;
}

function reigningCard(reigning) {
  const isA = reigning.team === 'team_a';
  const color = isA ? 'var(--orange-600)' : 'var(--gray-900)';
  return `<div class="card" style="border:2px solid ${isA ? 'var(--orange)' : '#000'}">
    <div class="between" style="margin-bottom:10px">
      <div>
        <h2 class="card__title">Aguardando desafiante</h2>
        <p class="muted" style="margin:2px 0 0">Vencedor da partida #${reigning.match.seq}</p>
      </div>
      <span class="badge-win ${isA ? 'badge-win--a' : 'badge-win--b'}">${isA ? 'Time Laranja' : 'Time Preto'}</span>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      ${reigning.players
        .map((name) => `<span style="font-size:12px;font-weight:700;color:${color};background:var(--gray-100);border-radius:999px;padding:3px 9px">${esc(name)}</span>`)
        .join('')}
    </div>
    <p class="muted" style="margin:10px 0 0">Os 7 primeiros da fila entram contra eles, mantendo a cor do vencedor.</p>
  </div>`;
}

function currentMatchCard(match) {
  return `<div class="hero hero--orange">
    <div class="between">
      <div>
        <p class="hero__sub" style="margin:0;text-transform:uppercase;font-size:11px;letter-spacing:.5px">Partida em andamento</p>
        <h2 class="hero__title">Partida #${match.seq}</h2>
      </div>
      <div class="score">
        <span class="score__num">${match.team_a_goals}</span>
        <span style="opacity:.7">x</span>
        <span class="score__num">${match.team_b_goals}</span>
      </div>
    </div>
    <div style="height:12px"></div>
    <button class="btn btn--white" data-act="open-match" data-id="${match.id}">Ver partida</button>
  </div>`;
}

function addPlayerCard() {
  return `<div class="card">
    <div class="seg" style="margin-bottom:12px">
      <button class="is-active" data-act="add-tab" data-tab="one">Um por vez</button>
      <button data-act="add-tab" data-tab="many">Vários de uma vez</button>
    </div>
    <form data-form="add-one" id="tab-one" class="row">
      <input class="input" name="player_name" placeholder="Nome do jogador" required maxlength="255" autocomplete="off">
      <button class="btn btn--orange btn--sm" type="submit" style="flex:none">Adicionar</button>
    </form>
    <form data-form="add-many" id="tab-many" class="hidden">
      <p class="muted" style="margin:0 0 6px">Um nome por linha</p>
      <textarea class="textarea" name="names" placeholder="João Silva&#10;Pedro Santos&#10;Lucas Oliveira" required></textarea>
      <div style="height:10px"></div>
      <button class="btn btn--orange" type="submit">Adicionar todos</button>
    </form>
  </div>`;
}

function queueCard(pool, editable) {
  const items = pool
    .map(
      (entry, i) => `
      <div class="pool-item" data-id="${entry.id}">
        <div class="pool-item__main">
          ${editable ? `<span class="drag-handle icon-btn" style="cursor:grab" title="Arrastar">☰</span>` : ''}
          <span class="pos">${i + 1}</span>
          <span class="name">${esc(entry.player_name)}</span>
        </div>
        ${
          editable
            ? `<div class="row" style="gap:0">
          <button class="icon-btn" data-act="move-up" data-id="${entry.id}" title="Subir" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="icon-btn" data-act="move-down" data-id="${entry.id}" title="Descer" ${i === pool.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="icon-btn icon-btn--warn" data-act="withdraw" data-name="${esc(entry.player_name)}" title="Desistir">⎋</button>
          <button class="icon-btn icon-btn--danger" data-act="remove-player" data-id="${entry.id}" title="Remover">✕</button>
        </div>`
            : ''
        }
      </div>`,
    )
    .join('');

  return `<div class="card">
    <div class="between" style="margin-bottom:10px">
      <h2 class="card__title">Fila de espera</h2>
      <span class="pill pill--offline">${pool.length} jogador(es)</span>
    </div>
    ${
      pool.length
        ? `${editable ? `<p class="muted" style="margin:0 0 8px">Arraste pelo ☰ ou use ▲▼ para reordenar</p>` : ''}<div id="pool-list" class="stack" style="gap:8px">${items}</div>`
        : `<div class="empty"><span class="empty__icon">👥</span>Nenhum jogador na fila</div>`
    }
  </div>`;
}

function withdrawnCard(list, editable) {
  if (!list || list.length === 0) return '';
  return `<div class="card" style="border-color:#fde68a">
    <div class="between" style="margin-bottom:10px">
      <h2 class="card__title" style="color:#a16207">Desistentes</h2>
      <span class="pill" style="background:var(--yellow-50);color:#a16207">${list.length}</span>
    </div>
    <div class="stack" style="gap:8px">
      ${list
        .map(
          (w) => `<div class="pool-item" style="background:#fffbeb">
            <span class="name">${esc(w.player_name)}</span>
            ${
              editable
                ? `<button class="btn btn--sm" style="background:var(--green-50);color:var(--green-700)" data-act="reinstate" data-id="${w.id}">Recolocar</button>`
                : ''
            }
          </div>`,
        )
        .join('')}
    </div>
  </div>`;
}

function createMatchButton(count, canCreate, required, hasReigning) {
  const label = canCreate
    ? hasReigning
      ? `Montar time (${count} na fila)`
      : `Criar partida (${count} jogadores)`
    : `Precisa de pelo menos ${required} jogadores (${count}/${required})`;
  return `<button class="btn btn--black" data-act="create-match" ${canCreate ? '' : 'disabled'}>${label}</button>`;
}

function historyCard(history) {
  return `<div class="card">
    <h2 class="card__title" style="margin-bottom:12px">Histórico de partidas</h2>
    ${history
      .map(
        (m) => `<button class="history-item" data-act="open-match" data-id="${m.id}">
        <div class="between">
          <span class="muted">Partida #${m.seq}</span>
          <span class="row" style="gap:6px">
            <strong style="color:var(--orange-600)">${m.team_a_goals}</strong>
            <span class="muted">x</span>
            <strong>${m.team_b_goals}</strong>
            <span class="badge-win ${m.winner === 'team_a' ? 'badge-win--a' : 'badge-win--b'}">${m.winner === 'team_a' ? 'Laranja' : 'Preto'}</span>
          </span>
        </div>
        <div class="history-item__teams">
          <div>${teamMini(m, 'team_a', 'Time Laranja', 'var(--orange-600)')}</div>
          <div>${teamMini(m, 'team_b', 'Time Preto', 'var(--gray-900)')}</div>
        </div>
      </button>`,
      )
      .join('')}
  </div>`;
}

function teamMini(match, team, label, color) {
  const players = match.players.filter((p) => p.team === team);
  return (
    `<p style="margin:0 0 4px;font-size:11px;font-weight:800;color:${color}">${label}</p>` +
    players
      .map(
        (p) =>
          `<p style="margin:0;font-size:12px;color:var(--gray-700)">${esc(p.player_name)}${
            p.goals > 0 ? ` <span class="goals">⚽${p.goals}</span>` : ''
          }</p>`,
      )
      .join('')
  );
}

function matchView() {
  const state = app.state;
  const match = state.matches.find((m) => m.id === app.route.matchId);
  if (!match) {
    return `<button class="back" data-act="nav-pool">‹ Voltar</button><div class="card"><div class="empty">Partida não encontrada.</div></div>`;
  }
  const owner = canEdit(state);
  const finalized = isFinalized(state);
  const editable = owner && !finalized;
  const inProgress = match.status === 'in_progress';
  const canRevert = editable && canRevertMatch(state, match);

  return `
    <button class="back" data-act="nav-pool">‹ Voltar</button>
    <div class="hero">
      <div class="between">
        <div>
          <h1 class="hero__title">Partida #${match.seq}</h1>
          <p class="hero__sub">${esc(state.event?.title || '')}</p>
          <p class="hero__sub" style="opacity:.7">${inProgress ? 'Em andamento' : 'Finalizada'}</p>
        </div>
        <div class="score">
          <span class="score__num score__num--a">${match.team_a_goals}</span>
          <span style="opacity:.6">x</span>
          <span class="score__num score__num--b">${match.team_b_goals}</span>
          <span class="score__lbl" style="color:var(--orange)">Laranja</span>
          <span class="score__lbl" style="opacity:.5">vs</span>
          <span class="score__lbl">Preto</span>
        </div>
      </div>
    </div>
    <div class="teams">
      ${teamCard(match, 'team_a', 'Time Laranja', 'a', inProgress && editable)}
      ${teamCard(match, 'team_b', 'Time Preto', 'b', inProgress && editable)}
    </div>
    ${matchEventsCard(match)}
    ${inProgress ? (editable ? finishCard(match) : readonlyCard('Partida em andamento')) : finishedCard(match, canRevert)}`;
}

function matchEventsCard(match) {
  const events = match.events || [];
  if (events.length === 0) return '';
  const icons = { substitute: '⇄', remove: '✕', goal: '⚽' };
  return `<div class="card">
    <h2 class="card__title" style="margin-bottom:10px">Movimentações</h2>
    <div class="stack" style="gap:6px">
      ${events
        .map(
          (ev) => `<div class="row" style="gap:8px;align-items:flex-start">
            <span style="font-size:14px;line-height:1.3">${icons[ev.type] || '•'}</span>
            <div style="min-width:0;flex:1">
              <p style="margin:0;font-size:13px;color:var(--gray-700)">${esc(ev.text)}</p>
              <p class="muted" style="margin:1px 0 0;font-size:11px">${formatTime(ev.created_at)}</p>
            </div>
          </div>`,
        )
        .join('')}
    </div>
  </div>`;
}

function readonlyCard(message) {
  return `<div class="card" style="text-align:center"><p class="muted" style="margin:0">${esc(message)}</p></div>`;
}

function teamCard(match, team, label, cls, inProgress) {
  const players = match.players.filter((p) => p.team === team);
  const rows = players
    .map(
      (p, i) => `<div class="player${inProgress ? ' player--editable' : ''}" ${inProgress ? `data-act="toggle-player" data-player="${p.id}"` : ''}>
      <div class="player__main">
        <span class="pos ${cls === 'b' ? 'pos--blue' : ''}" style="width:20px;height:20px;font-size:10px">${i + 1}</span>
        <span class="player__name">${esc(p.player_name)}</span>
        ${p.goals > 0 ? `<span class="goals">⚽ ${p.goals}</span>` : ''}
      </div>
      ${
        inProgress
          ? `<div class="player__actions">
        <button class="icon-btn icon-btn--ok" data-act="mark-goal" data-player="${p.id}" title="Marcar gol">＋</button>
        ${p.goals > 0 ? `<button class="icon-btn icon-btn--danger" data-act="remove-goal" data-player="${p.id}" title="Remover gol">－</button>` : ''}
        <button class="icon-btn icon-btn--blue player-action--more" data-act="substitute" data-player="${p.id}" data-name="${esc(p.player_name)}" title="Substituir">⇄</button>
        <button class="icon-btn icon-btn--danger player-action--more" data-act="remove-from-match" data-player="${p.id}" title="Remover">✕</button>
      </div>`
          : ''
      }
    </div>`,
    )
    .join('');

  return `<div class="team team--${cls}">
    <div class="team__head">
      <div class="team__badge team__badge--${cls}">${cls.toUpperCase()}</div>
      <span class="team__name team__name--${cls}">${label}</span>
    </div>
    ${rows || `<p class="muted" style="text-align:center">Nenhum jogador</p>`}
  </div>`;
}

function finishCard(match) {
  const cannotA = match.team_a_goals < match.team_b_goals;
  const cannotB = match.team_b_goals < match.team_a_goals;
  return `<div class="card">
    <h2 class="card__title" style="margin-bottom:12px">Quem venceu?</h2>
    <div class="teams">
      <button class="btn btn--orange" data-act="finish" data-winner="team_a" ${cannotA ? 'disabled' : ''}
        title="${cannotA ? 'Time Laranja tem menos gols' : 'Marcar Time Laranja como vencedor'}">✓ Laranja venceu</button>
      <button class="btn btn--black" data-act="finish" data-winner="team_b" ${cannotB ? 'disabled' : ''}
        title="${cannotB ? 'Time Preto tem menos gols' : 'Marcar Time Preto como vencedor'}">✓ Preto venceu</button>
    </div>
  </div>`;
}

function finishedCard(match, canRevert) {
  const aWon = match.winner === 'team_a';
  return `<div class="card" style="text-align:center">
    <div style="width:60px;height:60px;border-radius:50%;margin:0 auto 10px;display:grid;place-items:center;background:${aWon ? 'var(--orange-100)' : '#000'}">
      <span style="font-size:26px">🏆</span>
    </div>
    <p style="font-size:17px;font-weight:800;margin:0">${aWon ? 'Time Laranja' : 'Time Preto'} venceu!</p>
    <p class="muted" style="margin:4px 0 0">Os perdedores voltaram para o final da fila</p>
    ${canRevert ? `<div style="height:14px"></div><button class="btn btn--ghost btn--sm" data-act="revert" style="margin:0 auto">Desfazer resultado</button>` : ''}
  </div>`;
}

function scorersView() {
  const list = topScorers(app.state);
  return `
    <button class="back" data-act="nav-pool">‹ Voltar</button>
    <div class="hero hero--green">
      <div class="hero__row">
        <div class="hero__icon"><span style="font-size:22px">⚽</span></div>
        <div><h1 class="hero__title">Artilheiros</h1><p class="hero__sub">${esc(app.state.event?.title || '')}</p></div>
      </div>
    </div>
    ${
      list.length
        ? `<div class="card" style="padding:0;overflow:hidden">${list
            .map(
              (s, i) => `<div class="scorer ${i < 3 ? `scorer--${i + 1}` : ''}">
          <div class="scorer__rank">${i + 1}</div>
          <div class="scorer__name">${esc(s.player_name)}</div>
          <div class="scorer__goals">⚽ ${s.total_goals}</div>
        </div>`,
            )
            .join('')}</div>`
        : `<div class="card"><div class="empty"><span class="empty__icon">⚽</span>Nenhum gol registrado ainda</div></div>`
    }`;
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

let lastRouteKey = '';

function render() {
  if (isDragging()) {
    renderQueuedWhileDragging = true;
    return;
  }
  const view = document.getElementById('view');
  const active = document.activeElement;
  const focused =
    active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && view.contains(active)
      ? {
          name: active.getAttribute('name'),
          value: active.value,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
  const scrollY = window.scrollY;
  const routeKey = `${app.route.name}:${app.route.matchId || app.route.eventId || ''}`;
  const sameRoute = routeKey === lastRouteKey;
  lastRouteKey = routeKey;

  renderTopbar();
  if (app.route.name === 'home') view.innerHTML = homeView();
  else if (app.route.name === 'pool') view.innerHTML = poolView();
  else if (app.route.name === 'match') view.innerHTML = matchView();
  else if (app.route.name === 'scorers') view.innerHTML = scorersView();

  if (focused && focused.name) {
    const selector = `[name="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(focused.name) : focused.name}"]`;
    const restored = view.querySelector(selector);
    if (restored) {
      restored.value = focused.value;
      try {
        restored.setSelectionRange(focused.start, focused.end);
      } catch {
        // alguns tipos de input não suportam seleção
      }
      restored.focus({ preventScroll: true });
    }
  }

  afterRender();
  window.scrollTo(0, sameRoute ? scrollY : 0);
}

function afterRender() {
  const list = document.getElementById('pool-list');
  if (list) enableDrag(list);
}

function isDragging() {
  return draggingPool;
}

function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && document.getElementById('view').contains(el);
}

function requestRender() {
  if (isTyping() || isDragging()) {
    pendingRender = true;
    return;
  }
  render();
}

document.addEventListener('focusout', () => {
  if (!pendingRender) return;
  setTimeout(() => {
    if (pendingRender && !isTyping()) {
      pendingRender = false;
      render();
    }
  }, 0);
});

/* ------------------------------------------------------------------ */
/* Ações / dispatch                                                    */
/* ------------------------------------------------------------------ */

// Aplica a operação e renderiza de forma SÍNCRONA (ainda dentro do gesto do
// usuário), para o navegador manter o foco no campo que estava sendo digitado.
// A persistência (IndexedDB) e o sync acontecem depois, em segundo plano.
async function dispatch(type, payload = {}) {
  if (!app.state || !app.eventId) return false;
  let applied;
  try {
    applied = applyOp(app.state, { type, payload, actor: app.identity });
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
  app.state = applied.state;
  render();

  const eventId = app.eventId;
  const op = { id: uid(), eventId, seq: await store.nextSeq(), type, payload, created_at: nowIso() };
  await store.putState(eventId, app.state);
  await store.addOp(op);
  await sync.refreshPending(eventId);
  void pushOutbox(eventId);
  return true;
}

async function addMany(rawNames) {
  const names = rawNames.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return false;

  let state = app.state;
  const pending = [];
  const errors = [];
  for (const name of names) {
    try {
      state = applyOp(state, { type: 'add_player', payload: { player_name: name }, actor: app.identity }).state;
      pending.push({ type: 'add_player', payload: { player_name: name } });
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (pending.length === 0) {
    toast(errors[0] || 'Nada para adicionar.', 'error');
    return false;
  }

  app.state = state;
  render();
  toast(`${pending.length} adicionado(s)${errors.length ? ` · ${errors.length} ignorado(s)` : ''}`, errors.length ? 'error' : 'success');

  const eventId = app.eventId;
  for (const item of pending) {
    const op = { id: uid(), eventId, seq: await store.nextSeq(), ...item, created_at: nowIso() };
    await store.addOp(op);
  }
  await store.putState(eventId, app.state);
  await sync.refreshPending(eventId);
  void pushOutbox(eventId);
  return true;
}

async function pushOutbox(eventId = app.eventId) {
  if (!eventId) return;
  await sync.flush(eventId, app.identity, (message) => toast(message, 'error'));
  if (eventId === app.eventId) await refreshFromStore();
}

async function refreshFromStore() {
  if (!app.eventId) return;
  const fresh = await store.getState(app.eventId);
  if (!fresh) return;
  const changed = !app.state || fresh.version !== app.state.version;
  app.state = fresh;
  // requestRender adia a atualização se o usuário estiver digitando.
  if (changed) requestRender();
}

async function move(id, direction) {
  const pool = activePool(app.state);
  const index = pool.findIndex((e) => e.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pool.length) return;
  const ids = pool.map((e) => e.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await dispatch('reorder', { ordered_ids: ids });
}

/* ------------------------------------------------------------------ */
/* Modais                                                              */
/* ------------------------------------------------------------------ */

function openIdentityModal(required) {
  openModal({
    title: required ? 'Quem está usando?' : 'Sua identidade',
    body: `<p class="muted" style="margin:0 0 10px">Usamos seu nome para registrar quem montou os times (auditoria).</p>
      <input class="input" id="id-name" placeholder="Seu nome" value="${esc(app.identity.name)}" maxlength="80">
      <div style="height:10px"></div>
      <input class="input" id="id-phone" placeholder="Telefone (opcional)" value="${esc(app.identity.phone)}" maxlength="20" inputmode="tel">`,
    foot: `<button class="btn btn--orange" data-act="save-identity">Salvar</button>`,
    onMount: () => document.getElementById('id-name')?.focus(),
  });
}

async function saveIdentity() {
  const name = document.getElementById('id-name')?.value.trim() || '';
  const phone = document.getElementById('id-phone')?.value.trim() || '';
  if (!name) {
    toast('Informe seu nome.', 'error');
    return;
  }
  app.identity = { owner_id: app.identity.owner_id || uid(), name, phone };
  await store.setKv('identity', app.identity);
  closeModal();
  render();
  if (app.eventId) void pushOutbox();
}

function openNewEventModal() {
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const dateLabel = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  const defaultTitle = `Racha do ECC - ${dateLabel}`;
  openModal({
    title: 'Novo racha',
    body: `<form data-form="new-event" class="stack" style="gap:10px">
      <p class="muted" style="margin:0">Já deixamos tudo preenchido — pode ajustar se quiser.</p>
      <input class="input" name="title" placeholder="Título (ex: Racha do ECC)" value="${esc(defaultTitle)}" required maxlength="200">
      <input class="input" name="location" placeholder="Local (opcional)" value="Campo da PM" maxlength="200">
      <input class="input" name="event_date" type="date" value="${today}">
      <button class="btn btn--orange" type="submit">Criar racha</button>
    </form>`,
  });
}

function openSubstituteModal(playerId, playerName) {
  const pool = activePool(app.state);
  if (pool.length === 0) {
    toast('Não há jogadores na fila para substituir.', 'error');
    return;
  }
  openModal({
    title: `Substituir ${esc(playerName)}`,
    body: `<input class="input" id="sub-search" placeholder="Buscar jogador..." autocomplete="off">
      <div style="height:8px"></div>
      <div id="sub-list">
        ${pool
          .map(
            (entry) => `<button class="list-btn" data-act="sub-player" data-player="${playerId}" data-name="${esc(entry.player_name)}" data-search="${esc(entry.player_name.toLowerCase())}">
          <span class="pos pos--blue">${entry.position}</span>
          <span>${esc(entry.player_name)}</span>
          <span class="list-btn__enter">Entrar →</span>
        </button>`,
          )
          .join('')}
      </div>`,
    onMount: () => {
      const input = document.getElementById('sub-search');
      input.addEventListener('input', () => {
        const query = input.value.toLowerCase();
        document.querySelectorAll('#sub-list [data-search]').forEach((btn) => {
          btn.classList.toggle('hidden', Boolean(query) && !btn.dataset.search.includes(query));
        });
      });
      input.focus();
    },
  });
}

async function doSubstitute(playerId, nameIn) {
  closeModal();
  await dispatch('substitute_player', { game_id: app.route.matchId, player_id: playerId, player_in: nameIn });
}

function clearPlayerFocus() {
  document.querySelectorAll('.player.is-open').forEach((el) => el.classList.remove('is-open'));
}

function switchAddTab(tab) {
  document.querySelectorAll('[data-act="add-tab"]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  document.getElementById('tab-one')?.classList.toggle('hidden', tab !== 'one');
  document.getElementById('tab-many')?.classList.toggle('hidden', tab !== 'many');
}

/* ------------------------------------------------------------------ */
/* Drag & drop (pointer events: mouse + touch)                         */
/* ------------------------------------------------------------------ */

function enableDrag(container) {
  container.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const item = handle.closest('.pool-item');
      if (!item) return;

      event.preventDefault();
      let started = false;
      let lastY = event.clientY;
      let lastX = event.clientX;

      const onMove = (ev) => {
        lastY = ev.clientY;
        lastX = ev.clientX;

        // Só engata o arraste depois de um pequeno movimento, para não
        // confundir com toque/scroll.
        if (!started) {
          if (Math.abs(ev.clientY - startY) < 6 && Math.abs(ev.clientX - startX) < 6) return;
          started = true;
          draggingPool = true;
          item.classList.add('dragging');
          document.body.style.userSelect = 'none';
        }

        const items = Array.from(container.querySelectorAll('.pool-item:not(.dragging)'));
        let before = null;
        for (const el of items) {
          const rect = el.getBoundingClientRect();
          const outsideAbove = ev.clientY < rect.top;
          const outsideBelow = ev.clientY > rect.bottom;
          const insideTopHalf = ev.clientY >= rect.top && ev.clientY <= rect.top + rect.height / 2;
          if (outsideAbove || insideTopHalf) {
            before = el;
            break;
          }
          if (!outsideBelow) break;
        }
        if (before) container.insertBefore(item, before);
        else container.appendChild(item);

        autoScroll(ev.clientY);
      };

      const finish = (cancelled) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (!started) return;
        draggingPool = false;
        item.classList.remove('dragging');
        document.body.style.userSelect = '';

        if (cancelled) {
          if (renderQueuedWhileDragging) {
            renderQueuedWhileDragging = false;
            render();
          }
          return;
        }

        renderQueuedWhileDragging = false;
        const ids = Array.from(container.querySelectorAll('.pool-item')).map((el) => el.dataset.id);
        void dispatch('reorder', { ordered_ids: ids });
      };

      const onUp = () => finish(false);
      const onCancel = () => finish(true);

      const startY = event.clientY;
      const startX = event.clientX;
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  });
}

// Rola a página automaticamente quando o dedo chega perto do topo/rodapé.
function autoScroll(clientY) {
  const margin = 90;
  const speed = 14;
  if (clientY < margin) {
    window.scrollBy({ top: -(margin - clientY) / speed * 6, behavior: 'auto' });
  } else if (clientY > window.innerHeight - margin) {
    window.scrollBy({ top: (clientY - (window.innerHeight - margin)) / speed * 6, behavior: 'auto' });
  }
}

/* ------------------------------------------------------------------ */
/* Sincronização / navegação                                           */
/* ------------------------------------------------------------------ */

async function forceSync() {
  if (!navigator.onLine) {
    toast('Sem internet no momento.', 'error');
    return;
  }
  if (app.eventId) {
    await sync.syncEvent(app.eventId, app.identity, (message) => toast(message, 'error'));
    await refreshFromStore();
  } else {
    app.events = await sync.fetchEvents(app.identity.owner_id);
    render();
  }
  if (!sync.status.error) toast('Sincronizado!', 'success');
}

async function openEvent(eventId) {
  app.eventId = eventId;
  const pulled = await sync.pull(eventId, app.identity.owner_id);
  if (pulled) app.state = pulled;
  else app.state = (await store.getState(eventId)) || null;
  if (!app.state) {
    const meta = app.events.find((e) => e.id === eventId) || { id: eventId, title: 'Racha' };
    app.state = createEventState(meta);
    await store.putState(eventId, app.state);
  }
  await sync.refreshPending(eventId);
  void sync.syncEvent(eventId, app.identity, (message) => toast(message, 'error')).then(refreshFromStore);
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'e' && parts[1]) {
    if (parts[2] === 'm' && parts[3]) return { name: 'match', eventId: parts[1], matchId: parts[3] };
    if (parts[2] === 'scorers') return { name: 'scorers', eventId: parts[1] };
    return { name: 'pool', eventId: parts[1] };
  }
  return { name: 'home' };
}

function navigate(path) {
  location.hash = path;
}

async function handleRoute() {
  const route = parseRoute();
  if (route.eventId && route.eventId !== app.eventId) {
    await openEvent(route.eventId);
  } else if (!route.eventId) {
    app.eventId = null;
    app.state = null;
  }
  app.route = route;
  render();
}

/* ------------------------------------------------------------------ */
/* Event delegation                                                    */
/* ------------------------------------------------------------------ */

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  // Em telas touch, o toque num jogador fica "stuck" até o próximo toque.
  // Limpamos o destaque quando a ação não é mais do que alternar o jogador.
  if (act !== 'toggle-player' && !['mark-goal', 'remove-goal', 'substitute', 'remove-from-match'].includes(act)) {
    clearPlayerFocus();
  }

  switch (act) {
    case 'close-modal':
      closeModal();
      break;
    case 'toggle-player': {
      const card = el;
      const wasOpen = card.classList.contains('is-open');
      clearPlayerFocus();
      if (!wasOpen) card.classList.add('is-open');
      break;
    }
    case 'nav-home':
      navigate('/');
      break;
    case 'nav-pool':
      navigate(`/e/${app.eventId}`);
      break;
    case 'open-pool':
      navigate(`/e/${el.dataset.id}`);
      break;
    case 'open-match':
      navigate(`/e/${app.eventId}/m/${el.dataset.id}`);
      break;
    case 'open-scorers':
      navigate(`/e/${app.eventId}/scorers`);
      break;
    case 'toggle-sync':
      await forceSync();
      break;
    case 'identity':
      openIdentityModal(false);
      break;
    case 'save-identity':
      await saveIdentity();
      break;
    case 'new-event':
      openNewEventModal();
      break;
    case 'claim-events': {
      const claimed = await sync.claimOrphanEvents(app.identity.owner_id, app.identity.name);
      app.events = await sync.fetchEvents(app.identity.owner_id);
      render();
      toast(claimed ? `${claimed} racha(s) agora são seus.` : 'Nada para reivindicar.', claimed ? 'success' : 'error');
      break;
    }
    case 'add-tab':
      switchAddTab(el.dataset.tab);
      break;
    case 'withdraw':
      if (confirm(`Mover ${el.dataset.name} para desistentes?`)) await dispatch('withdraw', { player_name: el.dataset.name });
      break;
    case 'remove-player':
      if (confirm('Remover da fila?')) await dispatch('remove_player', { id: el.dataset.id });
      break;
    case 'reinstate':
      await dispatch('reinstate', { withdrawn_id: el.dataset.id });
      break;
    case 'move-up':
      await move(el.dataset.id, -1);
      break;
    case 'move-down':
      await move(el.dataset.id, 1);
      break;
    case 'create-match':
      await dispatch('create_match', {});
      break;
    case 'finalize-event':
      if (confirm('Deseja realmente finalizar este racha? Ele irá para "Anteriores" e ficará apenas como visualização.')) {
        if (await dispatch('finalize_event', {})) {
          app.events = await sync.fetchEvents(app.identity.owner_id);
          navigate('/');
        }
      }
      break;
    case 'reopen-event':
      if (confirm('Deseja reabrir este racha para voltar a montar os times?')) {
        await dispatch('reopen_event', {});
      }
      break;
    case 'mark-goal':
      await dispatch('mark_goal', { game_id: app.route.matchId, player_id: el.dataset.player });
      break;
    case 'remove-goal':
      await dispatch('remove_goal', { game_id: app.route.matchId, player_id: el.dataset.player });
      break;
    case 'remove-from-match':
      if (confirm('Remover da partida? Ele volta para o fim da fila.')) {
        await dispatch('remove_from_match', { game_id: app.route.matchId, player_id: el.dataset.player });
      }
      break;
    case 'substitute':
      openSubstituteModal(el.dataset.player, el.dataset.name);
      break;
    case 'sub-player':
      await doSubstitute(el.dataset.player, el.dataset.name);
      break;
    case 'finish':
      if (confirm('Finalizar a partida?')) {
        const ok = await dispatch('finish_match', { game_id: app.route.matchId, winner: el.dataset.winner });
        if (ok) navigate(`/e/${app.eventId}`);
      }
      break;
    case 'revert':
      if (confirm('Desfazer resultado? A partida voltará para em andamento.')) {
        await dispatch('revert_match', { game_id: app.route.matchId });
      }
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;

  if (kind === 'add-one') {
    const input = form.querySelector('[name="player_name"]');
    const name = input.value.trim();
    if (!name) return;
    input.focus(); // garante o foco antes do render (mantém o cursor no campo)
    if (await dispatch('add_player', { player_name: name })) {
      clearAndFocus('#view [name="player_name"]');
    }
  } else if (kind === 'add-many') {
    const textarea = form.querySelector('[name="names"]');
    textarea.focus();
    if (await addMany(textarea.value.split('\n'))) {
      clearAndFocus('#view [name="names"]');
    }
  } else if (kind === 'new-event') {
    const title = form.querySelector('[name="title"]').value.trim();
    const location = form.querySelector('[name="location"]').value.trim();
    const eventDate = form.querySelector('[name="event_date"]').value;
    if (!title) {
      toast('Informe o título.', 'error');
      return;
    }
    try {
      const created = await sync.createEvent({
        title,
        location,
        event_date: eventDate,
        owner_id: app.identity.owner_id,
        owner_name: app.identity.name,
      });
      closeModal();
      app.events = await sync.fetchEvents(app.identity.owner_id);
      toast('Racha criado!', 'success');
      navigate(`/e/${created.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  app.identity = (await store.getKv('identity')) || { owner_id: '', name: '', phone: '' };
  if (!app.identity.owner_id) {
    app.identity.owner_id = uid();
    await store.setKv('identity', app.identity);
  }

  sync.setOnline(navigator.onLine);
  sync.subscribe(() => renderTopbar());

  window.addEventListener('online', () => {
    sync.setOnline(true);
    void forceSync();
  });
  window.addEventListener('offline', () => sync.setOnline(false));
  window.addEventListener('hashchange', () => void handleRoute());

  app.events = await sync.fetchEvents(app.identity.owner_id);
  await handleRoute();

  if (!app.identity.name) openIdentityModal(true);

  // Garante a lista de rachas na tela inicial (abre direto num link, volta a
  // conexão, etc.).
  const reloadEvents = () =>
    sync
      .fetchEvents(app.identity.owner_id)
      .then((events) => {
        app.events = events;
        if (app.route.name === 'home') render();
      })
      .catch(() => {});

  if (navigator.onLine) void reloadEvents();
  window.addEventListener('focus', () => {
    if (navigator.onLine && app.route.name === 'home') void reloadEvents();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  setInterval(() => {
    if (app.eventId && navigator.onLine) {
      void sync.syncEvent(app.eventId, app.identity).then(refreshFromStore);
    }
  }, 20000);
}

init();
