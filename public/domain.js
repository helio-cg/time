// Domain logic — porta fiel de App\Services\TeamPoolService (gestao-racha).
// Módulo puro (sem APIs de Node/Worker/browser além de crypto/structuredClone),
// compartilhado entre o Worker (server) e o PWA (client). É a ÚNICA fonte das
// regras de negócio: fila, partidas, gols, substituição, desfazer e artilheiros.

export const TEAM_SIZE = 7;
export const TEAMS = { A: 'team_a', B: 'team_b' };

export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
  }
}

export function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function maxOf(nums, fallback = 0) {
  let max = fallback;
  for (const n of nums) {
    if (typeof n === 'number' && Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function sumGoals(players, team) {
  return players.reduce((sum, p) => (p.team === team ? sum + (p.goals || 0) : sum), 0);
}

export function activePool(state) {
  return state.pool
    .filter((e) => e.active)
    .slice()
    .sort((a, b) => a.position - b.position);
}

function renumberPositions(state) {
  activePool(state).forEach((entry, index) => {
    entry.position = index + 1;
  });
}

function nextPosition(state) {
  return maxOf(state.pool.map((e) => e.position), 0) + 1;
}

function nextMatchSeq(state) {
  return maxOf(state.matches.map((m) => m.seq), 0) + 1;
}

function findMatch(state, id) {
  const match = state.matches.find((m) => m.id === id);
  if (!match) throw new DomainError('Partida não encontrada.');
  return match;
}

function recalcScoreboard(match) {
  match.team_a_goals = sumGoals(match.players, TEAMS.A);
  match.team_b_goals = sumGoals(match.players, TEAMS.B);
}

function logMatchEvent(match, type, text) {
  if (!Array.isArray(match.events)) match.events = [];
  match.events.push({ id: uid(), type, text, created_at: nowIso() });
}

export function getCurrentMatch(state) {
  return state.matches.find((m) => m.status === 'in_progress') || null;
}

// Time vencedor que está aguardando na quadra (quando não há partida em
// andamento). É o vencedor da última partida finalizada; ele mantém a cor e
// espera os 7 primeiros da fila para o próximo jogo.
export function getReigningTeam(state) {
  if (getCurrentMatch(state)) return null;
  const finished = state.matches.filter((m) => m.status === 'finished' && m.winner);
  if (finished.length === 0) return null;
  const last = finished.reduce((acc, m) => (m.seq > acc.seq ? m : acc));
  return {
    match: last,
    team: last.winner,
    players: last.players.filter((p) => p.team === last.winner).map((p) => p.player_name),
  };
}

// 1ª partida: 14 jogadores (dois times). Depois, com o vencedor aguardando:
// apenas 7 (o time desafiante).
export function requiredPlayersToCreate(state) {
  return getReigningTeam(state) ? TEAM_SIZE : TEAM_SIZE * 2;
}

export function canCreateMatch(state) {
  if (getCurrentMatch(state)) return false;
  return activePool(state).length >= requiredPlayersToCreate(state);
}

export function matchHistory(state) {
  return state.matches
    .filter((m) => m.status === 'finished')
    .slice()
    .sort((a, b) => b.seq - a.seq);
}

export function canRevertMatch(state, match) {
  if (!match || match.status !== 'finished' || !match.queue_before) return false;
  const finished = state.matches.filter((m) => m.status === 'finished');
  if (finished.length === 0) return false;
  const last = finished.reduce((acc, m) => (m.seq > acc.seq ? m : acc));
  return last.id === match.id;
}

export function topScorers(state) {
  const totals = new Map();
  for (const match of state.matches) {
    for (const p of match.players) {
      if (!p.goals) continue;
      totals.set(p.player_name, (totals.get(p.player_name) || 0) + p.goals);
    }
  }
  return Array.from(totals.entries())
    .map(([player_name, total_goals]) => ({ player_name, total_goals }))
    .filter((row) => row.total_goals > 0)
    .sort((a, b) => b.total_goals - a.total_goals || a.player_name.localeCompare(b.player_name));
}

export function isFinalized(state) {
  return Boolean(state.event && state.event.finalized_at);
}

export function createEventState(event) {
  return {
    event: {
      id: event.id,
      title: event.title,
      location: event.location ?? null,
      event_date: event.event_date ?? null,
      owner_name: event.owner_name ?? null,
      finalized_at: event.finalized_at ?? null,
      is_owner: event.is_owner ?? false,
      ...event,
    },
    pool: [],
    withdrawn: [],
    matches: [],
    logs: [],
    version: 0,
  };
}

// Aplica UMA operação sobre o estado e devolve { state, action, description }.
// Lança DomainError quando a regra de negócio é violada.
export function applyOp(state, op) {
  const s = clone(state);
  const payload = op.payload || {};
  let action = null;
  let description = null;

  switch (op.type) {
    case 'add_player': {
      const name = String(payload.player_name ?? '').trim();
      if (!name) throw new DomainError('Nome do jogador não pode ser vazio.');
      if (s.pool.some((e) => e.active && e.player_name.trim() === name)) {
        throw new DomainError(`Jogador "${name}" já está na fila.`);
      }
      s.pool.push({ id: uid(), player_name: name, position: nextPosition(s), active: true, created_at: nowIso() });
      action = 'add_player';
      description = `Adicionou ${name} à fila`;
      break;
    }

    case 'remove_player': {
      const entry = s.pool.find((e) => e.id === payload.id && e.active);
      if (!entry) throw new DomainError('Jogador não encontrado na fila.');
      s.pool = s.pool.filter((e) => e.id !== entry.id);
      renumberPositions(s);
      action = 'remove_player';
      description = `Removeu ${entry.player_name} da fila`;
      break;
    }

    case 'withdraw': {
      const name = String(payload.player_name ?? '').trim();
      if (!name) throw new DomainError('Nome do jogador não pode ser vazio.');
      s.pool = s.pool.filter((e) => !(e.active && e.player_name.trim() === name));
      if (!s.withdrawn.some((w) => w.player_name.trim() === name)) {
        s.withdrawn.push({ id: uid(), player_name: name, created_at: nowIso() });
      }
      renumberPositions(s);
      action = 'withdraw';
      description = `${name} desistiu e saiu da fila`;
      break;
    }

    case 'reinstate': {
      const withdrawn = s.withdrawn.find((w) => w.id === payload.withdrawn_id);
      if (!withdrawn) throw new DomainError('Desistente não encontrado.');
      s.pool.push({
        id: uid(),
        player_name: withdrawn.player_name,
        position: nextPosition(s),
        active: true,
        created_at: nowIso(),
      });
      s.withdrawn = s.withdrawn.filter((w) => w.id !== withdrawn.id);
      action = 'reinstate';
      description = `Recolocou ${withdrawn.player_name} na fila`;
      break;
    }

    case 'reorder': {
      const orderedIds = Array.isArray(payload.ordered_ids) ? payload.ordered_ids : [];
      const index = new Map(orderedIds.map((id, i) => [id, i + 1]));
      for (const entry of s.pool) {
        if (entry.active && index.has(entry.id)) entry.position = index.get(entry.id);
      }
      action = 'reorder';
      description = 'Reordenou a fila';
      break;
    }

    case 'create_match': {
      if (getCurrentMatch(s)) {
        throw new DomainError('Já existe uma partida em andamento.');
      }

      const reigning = getReigningTeam(s);

      if (reigning) {
        // 2ª partida em diante: os 7 primeiros da fila entram no lugar do
        // perdedor, contra o vencedor, que MANTÉM a cor.
        const pool = activePool(s);
        if (pool.length < TEAM_SIZE) {
          throw new DomainError(`Necessário pelo menos ${TEAM_SIZE} jogadores na fila.`);
        }
        const challengers = pool.slice(0, TEAM_SIZE);
        const challengerIds = new Set(challengers.map((e) => e.id));
        const winnerTeam = reigning.team;
        const challengerTeam = winnerTeam === TEAMS.A ? TEAMS.B : TEAMS.A;

        const match = {
          id: uid(),
          seq: nextMatchSeq(s),
          status: 'in_progress',
          winner: null,
          team_a_goals: 0,
          team_b_goals: 0,
          queue_before: null,
          created_at: nowIso(),
          players: [],
          events: [],
        };
        for (const name of reigning.players) {
          match.players.push({ id: uid(), match_id: match.id, player_name: name, team: winnerTeam, goals: 0, created_at: nowIso() });
        }
        for (const entry of challengers) {
          match.players.push({
            id: uid(),
            match_id: match.id,
            player_name: entry.player_name,
            team: challengerTeam,
            goals: 0,
            created_at: nowIso(),
          });
        }
        s.pool = s.pool.filter((e) => !challengerIds.has(e.id));
        renumberPositions(s);
        // Liga a partida criada à partida do vencedor, para o "desfazer" remover.
        if (reigning.match.queue_before) reigning.match.queue_before.next_match_id = match.id;
        s.matches.push(match);
        action = 'create_match';
        description = `Gerou a partida #${match.seq} (desafiante)`;
        break;
      }

      // 1ª partida: 14 jogadores, distribuídos alternando as cores.
      if (activePool(s).length < TEAM_SIZE * 2) {
        throw new DomainError(`Necessário pelo menos ${TEAM_SIZE * 2} jogadores na fila.`);
      }
      const take = activePool(s).slice(0, TEAM_SIZE * 2);
      const takeIds = new Set(take.map((e) => e.id));
      const match = {
        id: uid(),
        seq: nextMatchSeq(s),
        status: 'in_progress',
        winner: null,
        team_a_goals: 0,
        team_b_goals: 0,
        queue_before: null,
        created_at: nowIso(),
        players: [],
        events: [],
      };
      take.forEach((entry, i) => {
        match.players.push({
          id: uid(),
          match_id: match.id,
          player_name: entry.player_name,
          team: i % 2 === 0 ? TEAMS.A : TEAMS.B,
          goals: 0,
          created_at: nowIso(),
        });
      });
      s.pool = s.pool.filter((e) => !takeIds.has(e.id));
      renumberPositions(s);
      s.matches.push(match);
      action = 'create_match';
      description = `Gerou a partida #${match.seq}`;
      break;
    }

    case 'remove_from_match': {
      const match = findMatch(s, payload.game_id);
      if (match.status !== 'in_progress') {
        throw new DomainError('Só é possível modificar partidas em andamento.');
      }
      const player = match.players.find((p) => p.id === payload.player_id);
      if (!player) throw new DomainError('Jogador não encontrado na partida.');
      match.players = match.players.filter((p) => p.id !== player.id);
      s.pool.push({
        id: uid(),
        player_name: player.player_name,
        position: nextPosition(s),
        active: true,
        created_at: nowIso(),
      });
      recalcScoreboard(match);
      logMatchEvent(match, 'remove', `${player.player_name} saiu da partida e voltou para o fim da fila`);
      action = 'remove_from_match';
      description = `Removeu ${player.player_name} da partida #${match.seq}`;
      break;
    }

    case 'substitute_player': {
      const match = findMatch(s, payload.game_id);
      if (match.status !== 'in_progress') {
        throw new DomainError('Só é possível modificar partidas em andamento.');
      }
      const playerOut = match.players.find((p) => p.id === payload.player_id);
      if (!playerOut) throw new DomainError('Jogador não encontrado na partida.');
      const nameIn = String(payload.player_in ?? '').trim();
      const poolEntry = s.pool.find((e) => e.active && e.player_name.trim() === nameIn);
      if (!poolEntry) throw new DomainError(`Jogador "${nameIn}" não encontrado na fila.`);
      const team = playerOut.team;
      s.pool = s.pool.filter((e) => e.id !== poolEntry.id);
      match.players = match.players.filter((p) => p.id !== playerOut.id);
      match.players.push({
        id: uid(),
        match_id: match.id,
        player_name: nameIn,
        team,
        goals: 0,
        created_at: nowIso(),
      });
      s.pool.push({
        id: uid(),
        player_name: playerOut.player_name,
        position: nextPosition(s),
        active: true,
        created_at: nowIso(),
      });
      recalcScoreboard(match);
      logMatchEvent(match, 'substitute', `${nameIn} entrou no lugar de ${playerOut.player_name}`);
      action = 'substitute_player';
      description = `Substituiu ${playerOut.player_name} por ${nameIn} na partida #${match.seq}`;
      break;
    }

    case 'mark_goal': {
      const match = findMatch(s, payload.game_id);
      if (match.status !== 'in_progress') {
        throw new DomainError('Só é possível marcar gols em partidas em andamento.');
      }
      const player = match.players.find((p) => p.id === payload.player_id);
      if (!player) throw new DomainError('Jogador não encontrado na partida.');
      player.goals = (player.goals || 0) + 1;
      recalcScoreboard(match);
      action = 'mark_goal';
      description = `Marcou gol de ${player.player_name} na partida #${match.seq}`;
      break;
    }

    case 'remove_goal': {
      const match = findMatch(s, payload.game_id);
      if (match.status !== 'in_progress') {
        throw new DomainError('Só é possível remover gols em partidas em andamento.');
      }
      const player = match.players.find((p) => p.id === payload.player_id);
      if (!player) throw new DomainError('Jogador não encontrado na partida.');
      if (player.goals > 0) player.goals -= 1;
      recalcScoreboard(match);
      action = 'remove_goal';
      description = `Removeu gol de ${player.player_name} na partida #${match.seq}`;
      break;
    }

    case 'finish_match': {
      const match = findMatch(s, payload.game_id);
      if (match.status !== 'in_progress') {
        throw new DomainError('Só é possível finalizar partidas em andamento.');
      }
      const winner = payload.winner;
      if (winner !== TEAMS.A && winner !== TEAMS.B) {
        throw new DomainError('Vencedor deve ser team_a ou team_b.');
      }
      const teamA = sumGoals(match.players, TEAMS.A);
      const teamB = sumGoals(match.players, TEAMS.B);
      const winnerGoals = winner === TEAMS.A ? teamA : teamB;
      const loserGoals = winner === TEAMS.A ? teamB : teamA;
      if (winnerGoals < loserGoals) {
        throw new DomainError('O time vencedor não pode ter menos gols que o perdedor.');
      }

      match.status = 'finished';
      match.winner = winner;
      match.team_a_goals = teamA;
      match.team_b_goals = teamB;

      const loser = winner === TEAMS.A ? TEAMS.B : TEAMS.A;
      const loserNames = match.players.filter((p) => p.team === loser).map((p) => p.player_name);

      // Snapshot exato da fila antes de qualquer modificação (para desfazer).
      const queueSnapshot = activePool(s).map((e) => e.player_name);

      // Perdedores vão para o final da fila. O vencedor permanece aguardando na
      // quadra (mantendo a cor) até alguém clicar em "Montar time".
      let position = nextPosition(s);
      for (const name of loserNames) {
        s.pool.push({ id: uid(), player_name: name, position: position++, active: true, created_at: nowIso() });
      }

      match.queue_before = {
        queue_snapshot: queueSnapshot,
        losers_added: loserNames,
        next_match_team_b: [],
        next_match_id: null,
      };
      action = 'finish_match';
      description = `Finalizou a partida #${match.seq} (vencedor: ${winner})`;
      break;
    }

    case 'revert_match': {
      const match = findMatch(s, payload.game_id);
      if (!match.queue_before) {
        throw new DomainError('Não é possível desfazer: dados de reversão não encontrados.');
      }
      if (match.queue_before.next_match_id) {
        s.matches = s.matches.filter((m) => m.id !== match.queue_before.next_match_id);
      }
      // Remove a fila ativa atual e restaura o snapshot exato.
      s.pool = s.pool.filter((e) => !e.active);
      const snapshot = match.queue_before.queue_snapshot || [];
      snapshot.forEach((name, i) => {
        s.pool.push({ id: uid(), player_name: name, position: i + 1, active: true, created_at: nowIso() });
      });
      match.status = 'in_progress';
      match.winner = null;
      match.team_a_goals = 0;
      match.team_b_goals = 0;
      action = 'revert_match';
      description = `Desfez o resultado da partida #${match.seq}`;
      break;
    }

    case 'finalize_event': {
      if (s.event.finalized_at) {
        throw new DomainError('Este racha já foi finalizado.');
      }
      s.event.finalized_at = nowIso();
      action = 'finalize_event';
      description = 'Finalizou o racha';
      break;
    }

    case 'reopen_event': {
      if (!s.event.finalized_at) {
        throw new DomainError('Este racha não está finalizado.');
      }
      s.event.finalized_at = null;
      action = 'reopen_event';
      description = 'Reabriu o racha';
      break;
    }

    default:
      throw new DomainError(`Operação desconhecida: ${op.type}`);
  }

  const actor = op.actor || {};
  s.logs.push({
    id: uid(),
    player_name: actor.name || 'Sistema',
    player_phone: actor.phone || '',
    action,
    description,
    created_at: nowIso(),
  });

  return { state: s, action, description };
}
