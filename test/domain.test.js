import { describe, it, expect } from 'vitest';
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
  DomainError,
} from '../public/domain.js';

const actor = { name: 'Tester', phone: '11999999999' };

function stateWithPlayers(count) {
  let state = createEventState({ id: 'evt-1', title: 'Racha', event_date: '2026-09-22' });
  for (let i = 1; i <= count; i++) {
    state = applyOp(state, { type: 'add_player', payload: { player_name: `Jogador ${i}` }, actor }).state;
  }
  return state;
}

function run(state, type, payload) {
  return applyOp(state, { type, payload, actor }).state;
}

describe('fila', () => {
  it('adiciona em ordem com posição incremental', () => {
    const state = stateWithPlayers(3);
    expect(activePool(state).map((e) => e.player_name)).toEqual(['Jogador 1', 'Jogador 2', 'Jogador 3']);
    expect(activePool(state).map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('rejeita nome vazio', () => {
    const state = stateWithPlayers(1);
    expect(() => run(state, 'add_player', { player_name: '   ' })).toThrow(DomainError);
  });

  it('rejeita jogador duplicado na fila', () => {
    const state = stateWithPlayers(2);
    expect(() => run(state, 'add_player', { player_name: 'Jogador 1' })).toThrow(/já está na fila/);
  });

  it('remove e renumera', () => {
    let state = stateWithPlayers(3);
    const second = activePool(state)[1];
    state = run(state, 'remove_player', { id: second.id });
    expect(activePool(state).map((e) => e.player_name)).toEqual(['Jogador 1', 'Jogador 3']);
    expect(activePool(state).map((e) => e.position)).toEqual([1, 2]);
  });

  it('desistir e recolocar', () => {
    let state = stateWithPlayers(2);
    state = run(state, 'withdraw', { player_name: 'Jogador 1' });
    expect(activePool(state).map((e) => e.player_name)).toEqual(['Jogador 2']);
    expect(state.withdrawn).toHaveLength(1);
    state = run(state, 'reinstate', { withdrawn_id: state.withdrawn[0].id });
    expect(activePool(state).map((e) => e.player_name)).toEqual(['Jogador 2', 'Jogador 1']);
    expect(state.withdrawn).toHaveLength(0);
  });

  it('reordena conforme lista de ids', () => {
    let state = stateWithPlayers(3);
    const ids = activePool(state).map((e) => e.id).reverse();
    state = run(state, 'reorder', { ordered_ids: ids });
    expect(activePool(state).map((e) => e.player_name)).toEqual(['Jogador 3', 'Jogador 2', 'Jogador 1']);
  });
});

describe('partida', () => {
  it('exige 14 jogadores', () => {
    const state = stateWithPlayers(13);
    expect(canCreateMatch(state)).toBe(false);
    expect(() => run(state, 'create_match', {})).toThrow(/14 jogadores/);
  });

  it('distribui alternando 7 por time', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const match = getCurrentMatch(state);
    expect(match.players.filter((p) => p.team === 'team_a')).toHaveLength(7);
    expect(match.players.filter((p) => p.team === 'team_b')).toHaveLength(7);
    expect(match.players[0].team).toBe('team_a');
    expect(match.players[1].team).toBe('team_b');
    expect(activePool(state)).toHaveLength(0);
  });

  it('marca e remove gol recalculando o placar', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const match = getCurrentMatch(state);
    const a = match.players.find((p) => p.team === 'team_a');
    const b = match.players.find((p) => p.team === 'team_b');
    state = run(state, 'mark_goal', { game_id: match.id, player_id: a.id });
    state = run(state, 'mark_goal', { game_id: match.id, player_id: a.id });
    state = run(state, 'mark_goal', { game_id: match.id, player_id: b.id });
    let current = getCurrentMatch(state);
    expect(current.team_a_goals).toBe(2);
    expect(current.team_b_goals).toBe(1);
    state = run(state, 'remove_goal', { game_id: match.id, player_id: a.id });
    current = getCurrentMatch(state);
    expect(current.team_a_goals).toBe(1);
  });

  it('finaliza: vencedor não pode ter menos gols', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const match = getCurrentMatch(state);
    const a = match.players.find((p) => p.team === 'team_a');
    state = run(state, 'mark_goal', { game_id: match.id, player_id: a.id });
    expect(() => run(state, 'finish_match', { game_id: match.id, winner: 'team_b' })).toThrow(/menos gols/);
  });

  it('finaliza: perdedores ao fim da fila e vencedor aguarda na quadra', () => {
    let state = stateWithPlayers(21);
    state = run(state, 'create_match', {});
    const first = getCurrentMatch(state);
    const winnerId = first.players.find((p) => p.team === 'team_a').id;
    state = run(state, 'mark_goal', { game_id: first.id, player_id: winnerId });
    state = run(state, 'finish_match', { game_id: first.id, winner: 'team_a' });

    const finished = matchHistory(state);
    expect(finished).toHaveLength(1);
    expect(finished[0].status).toBe('finished');
    expect(finished[0].winner).toBe('team_a');

    // Não cria partida automaticamente (o próximo jogo é manual).
    expect(getCurrentMatch(state)).toBeNull();
    // Fila: 7 que sobraram + 7 perdedores = 14.
    expect(activePool(state)).toHaveLength(14);

    // Vencedor aguardando, mantendo a cor.
    const reigning = getReigningTeam(state);
    expect(reigning).not.toBeNull();
    expect(reigning.team).toBe('team_a');
    expect(reigning.players).toHaveLength(7);
  });

  it('2ª partida: exige 7 e o vencedor mantém a cor', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const first = getCurrentMatch(state);
    // Vence o Time Preto (team_b) para provar que a cor é preservada.
    const winnerId = first.players.find((p) => p.team === 'team_b').id;
    state = run(state, 'mark_goal', { game_id: first.id, player_id: winnerId });
    state = run(state, 'finish_match', { game_id: first.id, winner: 'team_b' });

    expect(requiredPlayersToCreate(state)).toBe(7);
    expect(canCreateMatch(state)).toBe(true); // 7 perdedores na fila

    const reigning = getReigningTeam(state);
    expect(reigning.team).toBe('team_b');

    state = run(state, 'create_match', {});
    const next = getCurrentMatch(state);
    // Vencedor continua como Time Preto (team_b), sem trocar de camisa.
    expect(next.players.filter((p) => p.team === 'team_b').map((p) => p.player_name)).toEqual(reigning.players);
    // Desafiante (7 primeiros da fila) entra como Time Laranja (team_a).
    expect(next.players.filter((p) => p.team === 'team_a')).toHaveLength(7);
    expect(activePool(state)).toHaveLength(0);
  });

  it('com vencedor aguardando e menos de 7 na fila não permite montar', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const first = getCurrentMatch(state);
    const winnerId = first.players.find((p) => p.team === 'team_a').id;
    state = run(state, 'mark_goal', { game_id: first.id, player_id: winnerId });
    state = run(state, 'finish_match', { game_id: first.id, winner: 'team_a' });
    // remove 2 perdedores da fila -> sobram 5
    const toRemove = activePool(state).slice(0, 2);
    for (const entry of toRemove) state = run(state, 'remove_player', { id: entry.id });

    expect(activePool(state)).toHaveLength(5);
    expect(canCreateMatch(state)).toBe(false);
    expect(() => run(state, 'create_match', {})).toThrow(/pelo menos 7/);
  });

  it('desfazer após montar a 2ª partida remove a partida criada', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const first = getCurrentMatch(state);
    const winnerId = first.players.find((p) => p.team === 'team_a').id;
    state = run(state, 'mark_goal', { game_id: first.id, player_id: winnerId });
    state = run(state, 'finish_match', { game_id: first.id, winner: 'team_a' });

    state = run(state, 'create_match', {});
    const second = getCurrentMatch(state);
    expect(state.matches).toHaveLength(2);

    state = run(state, 'revert_match', { game_id: first.id });
    expect(state.matches).toHaveLength(1);
    expect(state.matches.find((m) => m.id === second.id)).toBeUndefined();
    expect(getCurrentMatch(state).id).toBe(first.id);
  });

  it('desfaz apenas a última partida finalizada, restaurando a fila', () => {
    let state = stateWithPlayers(21);
    state = run(state, 'create_match', {});
    const first = getCurrentMatch(state);
    const queueBefore = activePool(state).map((e) => e.player_name);
    const winnerId = first.players.find((p) => p.team === 'team_a').id;
    state = run(state, 'mark_goal', { game_id: first.id, player_id: winnerId });
    state = run(state, 'finish_match', { game_id: first.id, winner: 'team_a' });

    const finished = matchHistory(state)[0];
    expect(canRevertMatch(state, finished)).toBe(true);

    state = run(state, 'revert_match', { game_id: finished.id });
    const reverted = state.matches.find((m) => m.id === finished.id);
    expect(reverted.status).toBe('in_progress');
    expect(reverted.winner).toBeNull();
    // Próxima partida automática foi removida
    expect(state.matches).toHaveLength(1);
    // Fila restaurada exatamente (7 que sobraram)
    expect(activePool(state).map((e) => e.player_name)).toEqual(queueBefore);
  });

  it('substitui jogador mantendo o time e mandando o que saiu para o fim', () => {
    let state = stateWithPlayers(15);
    state = run(state, 'create_match', {});
    const match = getCurrentMatch(state);
    const out = match.players.find((p) => p.team === 'team_a');
    state = run(state, 'mark_goal', { game_id: match.id, player_id: out.id });
    const bench = activePool(state)[0];

    state = run(state, 'substitute_player', {
      game_id: match.id,
      player_id: out.id,
      player_in: bench.player_name,
    });

    const current = getCurrentMatch(state);
    const incoming = current.players.find((p) => p.player_name === bench.player_name);
    expect(incoming.team).toBe('team_a');
    expect(incoming.goals).toBe(0);
    expect(current.players.some((p) => p.id === out.id)).toBe(false);
    // Quem saiu foi para o fim da fila
    const pool = activePool(state);
    expect(pool[pool.length - 1].player_name).toBe(out.player_name);
  });

  it('remove jogador da partida e devolve ao fim da fila', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const match = getCurrentMatch(state);
    const player = match.players[0];
    state = run(state, 'remove_from_match', { game_id: match.id, player_id: player.id });
    expect(getCurrentMatch(state).players).toHaveLength(13);
    const pool = activePool(state);
    expect(pool[pool.length - 1].player_name).toBe(player.player_name);
  });

  it('registra remoção e substituição no histórico da partida', () => {
    let state = stateWithPlayers(15);
    state = run(state, 'create_match', {});
    let match = getCurrentMatch(state);
    const removed = match.players[0];
    state = run(state, 'remove_from_match', { game_id: match.id, player_id: removed.id });

    match = getCurrentMatch(state);
    expect(match.events).toHaveLength(1);
    expect(match.events[0].type).toBe('remove');
    expect(match.events[0].text).toContain(removed.player_name);

    const out = match.players.find((p) => p.team === 'team_a');
    const bench = activePool(state)[0];
    state = run(state, 'substitute_player', {
      game_id: match.id,
      player_id: out.id,
      player_in: bench.player_name,
    });

    match = getCurrentMatch(state);
    expect(match.events).toHaveLength(2);
    expect(match.events[1].type).toBe('substitute');
    expect(match.events[1].text).toContain(bench.player_name);
    expect(match.events[1].text).toContain(out.player_name);
  });
});

describe('artilheiros', () => {
  it('soma gols por jogador e ordena', () => {
    let state = stateWithPlayers(14);
    state = run(state, 'create_match', {});
    const match = getCurrentMatch(state);
    const a1 = match.players.find((p) => p.team === 'team_a');
    const a2 = match.players.filter((p) => p.team === 'team_a')[1];
    const b1 = match.players.find((p) => p.team === 'team_b');
    state = run(state, 'mark_goal', { game_id: match.id, player_id: a1.id });
    state = run(state, 'mark_goal', { game_id: match.id, player_id: a1.id });
    state = run(state, 'mark_goal', { game_id: match.id, player_id: a2.id });
    state = run(state, 'mark_goal', { game_id: match.id, player_id: b1.id });

    const scorers = topScorers(state);
    expect(scorers[0]).toMatchObject({ player_name: a1.player_name, total_goals: 2 });
    expect(scorers).toHaveLength(3);
  });
});

describe('finalizar racha', () => {
  it('alterna entre finalizado e reaberto', () => {
    let state = stateWithPlayers(2);
    expect(isFinalized(state)).toBe(false);

    state = run(state, 'finalize_event', {});
    expect(isFinalized(state)).toBe(true);

    expect(() => run(state, 'finalize_event', {})).toThrow(/já foi finalizado/);

    state = run(state, 'reopen_event', {});
    expect(isFinalized(state)).toBe(false);

    expect(() => run(state, 'reopen_event', {})).toThrow(/não está finalizado/);
  });
});
