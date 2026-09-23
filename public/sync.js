// Engine de sincronização offline-first.
// Estratégia: o cliente aplica as operações localmente na hora e enfileira no
// outbox (IndexedDB). Quando há internet, o outbox é enviado em lote para a API,
// que reaplica as operações sobre o estado autoritativo (D1) de forma idempotente
// e devolve o estado canônico. O cliente adota o estado devolvido.
// Enquanto offline tudo funciona; ao voltar a conexão, sincroniza sozinho.

import * as store from './store.js';

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(status);
}

export const status = {
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  syncing: false,
  pending: 0,
  error: null,
  lastSyncAt: null,
};

function setStatus(patch) {
  Object.assign(status, patch);
  emit();
}

export function setOnline(online) {
  setStatus({ online });
}

export async function refreshPending(eventId) {
  const pending = eventId ? await store.countOps(eventId) : 0;
  setStatus({ pending });
  return pending;
}

export async function fetchEvents(ownerId = '') {
  if (status.online) {
    try {
      const res = await fetch(`/api/events?owner=${encodeURIComponent(ownerId)}`);
      if (res.ok) {
        const data = await res.json();
        await store.setKv('events_cache', data.events || []);
        return data.events || [];
      }
    } catch {
      // cai no cache
    }
  }
  return (await store.getKv('events_cache')) || [];
}

export async function createEvent({ title, location, event_date, owner_id, owner_name }) {
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, location, event_date, owner_id, owner_name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Não foi possível criar o racha.');
  }
  const data = await res.json();
  const cached = (await store.getKv('events_cache')) || [];
  cached.unshift(data.event);
  await store.setKv('events_cache', cached);
  return data.event;
}

export async function claimOrphanEvents(ownerId, ownerName) {
  if (!status.online) return 0;
  try {
    const res = await fetch('/api/events/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_id: ownerId, owner_name: ownerName }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.claimed || 0;
  } catch {
    return 0;
  }
}

export async function pull(eventId, ownerId = '') {
  if (!status.online) return null;
  try {
    const res = await fetch(`/api/events/${eventId}/state?owner=${encodeURIComponent(ownerId)}`);
    if (!res.ok) return null;
    const state = await res.json();
    await store.putState(eventId, state);
    await store.setKv(`serverVersion:${eventId}`, state.version ?? 0);
    return state;
  } catch {
    return null;
  }
}

export async function flush(eventId, actor, onFailure) {
  if (!status.online) return { skipped: true };
  const queued = await store.listOps(eventId);
  if (queued.length === 0) return { skipped: true };

  setStatus({ syncing: true, error: null });
  try {
    let guard = 0;
    while (guard++ < 100) {
      const batch = (await store.listOps(eventId)).slice(0, 100);
      if (batch.length === 0) break;

      const res = await fetch(`/api/events/${eventId}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ops: batch.map((op) => ({ id: op.id, type: op.type, payload: op.payload })),
          actor,
        }),
      });

      if (res.status === 403) throw new Error('Apenas quem criou este racha pode alterá-lo.');
      if (res.status === 404) throw new Error('Racha não encontrado no servidor.');
      if (res.status === 409) throw new Error('Conflito de sincronização. Tente novamente.');
      if (!res.ok) throw new Error(`Falha ao sincronizar (${res.status}).`);

      const data = await res.json();
      const failures = (data.results || []).filter((r) => !r.ok);
      if (failures.length && typeof onFailure === 'function') {
        onFailure(failures[0].error || 'Operação rejeitada pelo servidor.');
      }
      for (const op of batch) {
        await store.deleteOp(op.id);
      }
      if (data.state) {
        await store.putState(eventId, data.state);
        await store.setKv(`serverVersion:${eventId}`, data.state.version ?? 0);
      }
      if (batch.length < 100) break;
    }
    setStatus({ lastSyncAt: Date.now(), error: null });
  } catch (err) {
    setStatus({ error: err.message });
  } finally {
    setStatus({ syncing: false });
    await refreshPending(eventId);
  }
  return { done: true };
}

export async function syncEvent(eventId, actor, onFailure) {
  await flush(eventId, actor, onFailure);
  if (status.online) {
    const pending = await store.countOps(eventId);
    if (pending === 0) await pull(eventId);
  }
  await refreshPending(eventId);
}
