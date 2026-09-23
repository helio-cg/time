// Persistência local offline-first via IndexedDB.
// Stores:
//  - states  (key: eventId)              -> estado completo do evento
//  - outbox  (keyPath: id, index: eventId, seq) -> operações pendentes de envio
//  - kv      (keyPath: key)              -> identidade, versão do servidor, cache de eventos

const DB_NAME = 'racha-times';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('states')) {
        db.createObjectStore('states', { keyPath: 'event.id' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('by_event', 'eventId');
        outbox.createIndex('by_seq', 'seq');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getState(eventId) {
  const store = await tx('states', 'readonly');
  return request(store.get(eventId));
}

export async function putState(eventId, state) {
  const store = await tx('states', 'readwrite');
  return request(store.put(state));
}

export async function addOp(op) {
  const store = await tx('outbox', 'readwrite');
  return request(store.put(op));
}

export async function listOps(eventId) {
  const store = await tx('outbox', 'readonly');
  const rows = await request(store.index('by_event').getAll(eventId));
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function countOps(eventId) {
  const store = await tx('outbox', 'readonly');
  return request(store.index('by_event').count(eventId));
}

export async function deleteOp(id) {
  const store = await tx('outbox', 'readwrite');
  return request(store.delete(id));
}

export async function nextSeq() {
  const current = (await getKv('outbox_seq')) || 0;
  const next = current + 1;
  await setKv('outbox_seq', next);
  return next;
}

export async function getKv(key) {
  const store = await tx('kv', 'readonly');
  const row = await request(store.get(key));
  return row ? row.value : null;
}

export async function setKv(key, value) {
  const store = await tx('kv', 'readwrite');
  return request(store.put({ key, value }));
}
