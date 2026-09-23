-- Schema D1 para o app "Montar Times".
-- Execute com: npm run db:init:local  (dev)  /  npm run db:init:remote (produção)

DROP TABLE IF EXISTS match_players;
DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS team_pool;
DROP TABLE IF EXISTS withdrawn_players;
DROP TABLE IF EXISTS team_action_logs;
DROP TABLE IF EXISTS applied_ops;
DROP TABLE IF EXISTS events;

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  location     TEXT,
  event_date   TEXT NOT NULL,
  owner_id     TEXT,
  owner_name   TEXT,
  finalized_at TEXT,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE team_pool (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  player_name TEXT NOT NULL,
  position    INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_team_pool_event ON team_pool (event_id, active, position);

CREATE TABLE withdrawn_players (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  player_name TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_withdrawn_event ON withdrawn_players (event_id, created_at);

CREATE TABLE matches (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  winner       TEXT,
  team_a_goals INTEGER NOT NULL DEFAULT 0,
  team_b_goals INTEGER NOT NULL DEFAULT 0,
  queue_before TEXT,
  events       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_matches_event ON matches (event_id, seq);

CREATE TABLE match_players (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL,
  player_name TEXT NOT NULL,
  team        TEXT NOT NULL,
  goals       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_match_players_match ON match_players (match_id, created_at);

CREATE TABLE team_action_logs (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  player_name  TEXT NOT NULL,
  player_phone TEXT,
  action       TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_logs_event ON team_action_logs (event_id, created_at);

CREATE TABLE applied_ops (
  op_id      TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX idx_applied_ops_event ON applied_ops (event_id);
