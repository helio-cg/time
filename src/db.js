// Camada D1. Carrega o estado completo de um evento, aplica operações de domínio
// (via public/domain.js) e persiste o estado resultante de forma atômica.
// Operações são idempotentes por op_id (tabela applied_ops).

import { applyOp, nowIso } from '../public/domain.js';

function parseQueue(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function loadState(env, eventId, ownerId = null) {
  const eventRow = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!eventRow) return null;

  const [poolRows, withdrawnRows, matchRows, logRows] = await Promise.all([
    env.DB.prepare('SELECT * FROM team_pool WHERE event_id = ? ORDER BY position').bind(eventId).all(),
    env.DB.prepare('SELECT * FROM withdrawn_players WHERE event_id = ? ORDER BY created_at').bind(eventId).all(),
    env.DB.prepare('SELECT * FROM matches WHERE event_id = ? ORDER BY seq').bind(eventId).all(),
    env.DB.prepare('SELECT * FROM team_action_logs WHERE event_id = ? ORDER BY created_at').bind(eventId).all(),
  ]);

  const matchIds = matchRows.results.map((m) => m.id);
  const playersByMatch = new Map();
  if (matchIds.length > 0) {
    const placeholders = matchIds.map(() => '?').join(',');
    const playerRows = await env.DB.prepare(
      `SELECT * FROM match_players WHERE match_id IN (${placeholders}) ORDER BY created_at`,
    )
      .bind(...matchIds)
      .all();
    for (const p of playerRows.results) {
      if (!playersByMatch.has(p.match_id)) playersByMatch.set(p.match_id, []);
      playersByMatch.get(p.match_id).push({
        id: p.id,
        match_id: p.match_id,
        player_name: p.player_name,
        team: p.team,
        goals: p.goals,
        created_at: p.created_at,
      });
    }
  }

  return {
    event: {
      id: eventRow.id,
      title: eventRow.title,
      location: eventRow.location,
      event_date: eventRow.event_date,
      owner_name: eventRow.owner_name,
      finalized_at: eventRow.finalized_at,
      is_owner: Boolean(ownerId) && eventRow.owner_id === ownerId,
      created_at: eventRow.created_at,
      updated_at: eventRow.updated_at,
    },
    pool: poolRows.results.map((e) => ({
      id: e.id,
      player_name: e.player_name,
      position: e.position,
      active: !!e.active,
      created_at: e.created_at,
    })),
    withdrawn: withdrawnRows.results.map((w) => ({
      id: w.id,
      player_name: w.player_name,
      created_at: w.created_at,
    })),
    matches: matchRows.results.map((m) => ({
      id: m.id,
      seq: m.seq,
      status: m.status,
      winner: m.winner,
      team_a_goals: m.team_a_goals,
      team_b_goals: m.team_b_goals,
      queue_before: parseQueue(m.queue_before),
      events: parseQueue(m.events) || [],
      created_at: m.created_at,
      updated_at: m.updated_at,
      players: playersByMatch.get(m.id) || [],
    })),
    logs: logRows.results.map((l) => ({
      id: l.id,
      player_name: l.player_name,
      player_phone: l.player_phone,
      action: l.action,
      description: l.description,
      created_at: l.created_at,
    })),
    version: eventRow.version,
  };
}

async function getAppliedOpIds(env, ids) {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT op_id FROM applied_ops WHERE op_id IN (${placeholders})`)
    .bind(...ids)
    .all();
  return new Set(rows.results.map((r) => r.op_id));
}

async function persist(env, eventId, state, appliedIds) {
  const now = nowIso();
  const stmts = [];

  // Campos do evento que podem mudar via operações (ex.: finalizar/reabrir).
  stmts.push(
    env.DB.prepare('UPDATE events SET finalized_at = ?, updated_at = ? WHERE id = ?').bind(
      state.event?.finalized_at ?? null,
      now,
      eventId,
    ),
  );

  stmts.push(env.DB.prepare('DELETE FROM match_players WHERE match_id IN (SELECT id FROM matches WHERE event_id = ?)').bind(eventId));
  stmts.push(env.DB.prepare('DELETE FROM matches WHERE event_id = ?').bind(eventId));
  stmts.push(env.DB.prepare('DELETE FROM team_pool WHERE event_id = ?').bind(eventId));
  stmts.push(env.DB.prepare('DELETE FROM withdrawn_players WHERE event_id = ?').bind(eventId));
  stmts.push(env.DB.prepare('DELETE FROM team_action_logs WHERE event_id = ?').bind(eventId));

  for (const match of state.matches) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO matches (id, event_id, seq, status, winner, team_a_goals, team_b_goals, queue_before, events, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        match.id,
        eventId,
        match.seq,
        match.status,
        match.winner ?? null,
        match.team_a_goals || 0,
        match.team_b_goals || 0,
        match.queue_before ? JSON.stringify(match.queue_before) : null,
        JSON.stringify(match.events || []),
        match.created_at || now,
        now,
      ),
    );
    for (const player of match.players) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO match_players (id, match_id, player_name, team, goals, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(player.id, match.id, player.player_name, player.team, player.goals || 0, player.created_at || now),
      );
    }
  }

  for (const entry of state.pool) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO team_pool (id, event_id, player_name, position, active, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(entry.id, eventId, entry.player_name, entry.position, entry.active ? 1 : 0, entry.created_at || now),
    );
  }

  for (const w of state.withdrawn) {
    stmts.push(
      env.DB.prepare('INSERT INTO withdrawn_players (id, event_id, player_name, created_at) VALUES (?, ?, ?, ?)').bind(
        w.id,
        eventId,
        w.player_name,
        w.created_at || now,
      ),
    );
  }

  for (const log of state.logs) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO team_action_logs (id, event_id, player_name, player_phone, action, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(log.id, eventId, log.player_name, log.player_phone || '', log.action, log.description || '', log.created_at || now),
    );
  }

  for (const opId of appliedIds) {
    stmts.push(
      env.DB.prepare('INSERT OR IGNORE INTO applied_ops (op_id, event_id, applied_at) VALUES (?, ?, ?)').bind(
        opId,
        eventId,
        now,
      ),
    );
  }

  await env.DB.batch(stmts);
}

// Aplica um lote de operações. Idempotente e com retry em conflito de versão.
export async function applyOps(env, eventId, ops, actor) {
  const MAX_ATTEMPTS = 4;

  // Autorização: só o dono do racha (mesmo owner_id) pode alterar.
  const ownerRow = await env.DB.prepare('SELECT owner_id FROM events WHERE id = ?').bind(eventId).first();
  if (!ownerRow) return { notFound: true };
  if (ownerRow.owner_id && ownerRow.owner_id !== actor?.owner_id) return { forbidden: true };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = await loadState(env, eventId, actor?.owner_id);
    if (!state) return { notFound: true };

    const existing = await getAppliedOpIds(env, ops.map((o) => o.id));
    const fresh = ops.filter((o) => !existing.has(o.id));

    if (fresh.length === 0) {
      return { state, results: ops.map((o) => ({ id: o.id, ok: true, duplicate: true })) };
    }

    // Guarda otimista de versão: reivindica a próxima versão. Se outro
    // escritor chegou antes, `changes` é 0 e tentamos de novo com estado fresco.
    const guard = await env.DB.prepare('UPDATE events SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
      .bind(nowIso(), eventId, state.version)
      .run();
    if (!guard.meta.changes) continue;

    let current = state;
    const results = [];
    const appliedIds = [];

    for (const op of fresh) {
      try {
        const applied = applyOp(current, { type: op.type, payload: op.payload, actor });
        current = applied.state;
        results.push({ id: op.id, ok: true });
        appliedIds.push(op.id);
      } catch (err) {
        results.push({ id: op.id, ok: false, error: err.message });
      }
    }

    const newVersion = state.version + 1;
    await persist(env, eventId, current, appliedIds);
    current.version = newVersion;
    return { state: current, results };
  }

  return { conflict: true };
}
