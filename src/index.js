import { Hono } from 'hono';
import { uid, nowIso } from '../public/domain.js';
import { applyOps, loadState } from './db.js';

const app = new Hono();

const MAX_BATCH = 200;

function sanitizeActor(actor) {
  if (!actor || typeof actor !== 'object') return {};
  return {
    name: String(actor.name ?? '').slice(0, 120),
    phone: String(actor.phone ?? '').slice(0, 40),
    owner_id: String(actor.owner_id ?? '').slice(0, 80),
  };
}

function sanitizeOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops
    .filter((op) => op && typeof op === 'object' && typeof op.type === 'string' && typeof op.id === 'string')
    .slice(0, MAX_BATCH)
    .map((op) => ({
      id: op.id.slice(0, 80),
      type: op.type.slice(0, 40),
      payload: op.payload && typeof op.payload === 'object' ? op.payload : {},
    }));
}

app.get('/api/health', (c) => c.json({ ok: true, time: nowIso() }));

app.get('/api/events', async (c) => {
  const owner = c.req.query('owner') || '';
  const rows = await c.env.DB.prepare(
    `SELECT id, title, location, event_date, owner_id, owner_name, finalized_at, version, created_at
       FROM events ORDER BY finalized_at IS NOT NULL, event_date DESC, created_at DESC`,
  ).all();
  const events = rows.results.map((row) => ({
    id: row.id,
    title: row.title,
    location: row.location,
    event_date: row.event_date,
    owner_name: row.owner_name,
    finalized_at: row.finalized_at,
    version: row.version,
    created_at: row.created_at,
    is_owner: Boolean(owner) && row.owner_id === owner,
  }));
  return c.json({ events });
});

app.post('/api/events', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title ?? '').trim();
  if (!title) return c.json({ error: 'Informe o título do racha.' }, 400);

  const ownerId = String(body.owner_id ?? '').trim().slice(0, 80);
  if (!ownerId) return c.json({ error: 'Identificação do criador ausente.' }, 400);
  const ownerName = String(body.owner_name ?? '').trim().slice(0, 120) || 'Anônimo';

  const id = uid();
  const location = body.location ? String(body.location).trim().slice(0, 200) : null;
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(body.event_date || '')
    ? body.event_date
    : new Date().toISOString().slice(0, 10);
  const now = nowIso();

  await c.env.DB.prepare(
    'INSERT INTO events (id, title, location, event_date, owner_id, owner_name, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
  )
    .bind(id, title.slice(0, 200), location, eventDate, ownerId, ownerName, now, now)
    .run();

  return c.json(
    {
      event: {
        id,
        title,
        location,
        event_date: eventDate,
        owner_name: ownerName,
        finalized_at: null,
        version: 0,
        created_at: now,
        is_owner: true,
      },
    },
    201,
  );
});

// Reivindica rachas antigos sem dono (criados antes desta versão) para o
// dispositivo atual. Só afeta eventos com owner_id nulo.
app.post('/api/events/claim', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ownerId = String(body.owner_id ?? '').trim().slice(0, 80);
  const ownerName = String(body.owner_name ?? '').trim().slice(0, 120) || 'Anônimo';
  if (!ownerId) return c.json({ error: 'Identificação ausente.' }, 400);

  const result = await c.env.DB.prepare(
    'UPDATE events SET owner_id = ?, owner_name = ?, updated_at = ? WHERE owner_id IS NULL',
  )
    .bind(ownerId, ownerName, nowIso())
    .run();

  return c.json({ claimed: result.meta.changes || 0 });
});

app.get('/api/events/:eventId/state', async (c) => {
  const state = await loadState(c.env, c.req.param('eventId'), c.req.query('owner') || null);
  if (!state) return c.json({ error: 'Evento não encontrado.' }, 404);
  return c.json(state);
});

app.post('/api/events/:eventId/ops', async (c) => {
  const eventId = c.req.param('eventId');
  const body = await c.req.json().catch(() => ({}));
  const ops = sanitizeOps(body.ops);
  const actor = sanitizeActor(body.actor);

  if (ops.length === 0) {
    const state = await loadState(c.env, eventId, actor.owner_id || null);
    if (!state) return c.json({ error: 'Evento não encontrado.' }, 404);
    return c.json({ state, results: [] });
  }

  const outcome = await applyOps(c.env, eventId, ops, actor);
  if (outcome.notFound) return c.json({ error: 'Evento não encontrado.' }, 404);
  if (outcome.forbidden) return c.json({ error: 'Apenas quem criou este racha pode alterá-lo.' }, 403);
  if (outcome.conflict) return c.json({ error: 'Conflito de sincronização, tente novamente.' }, 409);

  return c.json({ state: outcome.state, results: outcome.results });
});

export default app;
