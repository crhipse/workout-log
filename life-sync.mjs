// Source-only synchronization. Credentials and the durable outbox never enter workout backups.
export const LIFE_ORIGIN = 'https://life-chronicle.crhipse.workers.dev';
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const SET_FIELDS = ['id', 'exId', 'date', 'kg', 'reps', 'hard', 'warmup', 'restSec', 'ts'];
const EXERCISE_FIELDS = ['id', 'baseName', 'variant', 'bodyPart', 'unit', 'memo'];
const REJECTED_PAYLOAD = ['too_large', 'bad_data', 'empty_initial_snapshot'];
const blocksSending = error => error === 'reconnect' || REJECTED_PAYLOAD.includes(error);
const sortIds = (a, b) => String(a.id).localeCompare(String(b.id));

export function safeValidationPath(value) {
  return typeof value === 'string' && value.length <= 160 && !/\s/.test(value) && /^(?:version|exercises(?:\[\d{1,4}\](?:\.(?:id|bodyPart))?)?|sets(?:\[\d{1,5}\](?:\.(?:id|exId|date|hard|warmup|reps|kg|restSec|ts))?)?)$/.test(value) ? value : null;
}

export function projectWorkout(db) {
  return { version: 1,
    exercises: (db.exercises || []).map(row => pick(row, ['id', 'bodyPart'])).sort(sortIds),
    sets: (db.sets || []).map(row => ({ ...pick(row, SET_FIELDS),
      // Earlier versions did not store these optional controls. The original UI
      // treats a missing/null flag as unchecked; normalize only the sent copy.
      hard: row?.hard ?? false, warmup: row?.warmup ?? false,
      restSec: row?.restSec ?? null, ts: row?.ts ?? null,
    })).sort(sortIds),
  };
}

export function workoutBackup(db) {
  const ui = pick(db.ui || {}, ['autoTimer', 'lastTab']);
  if (db.ui?.timer) ui.timer = pick(db.ui.timer, ['startTs', 'endedSec']);
  else if (db.ui?.timer === null) ui.timer = null;
  return { version: 1, exercises: (db.exercises || []).map(row => pick(row, EXERCISE_FIELDS)),
    sets: (db.sets || []).map(row => pick(row, SET_FIELDS)), ui };
}

export async function snapshotDigest(payload) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const blank = () => ({ version: 1, token: null, deviceId: null, revision: 0, pair: null,
  pending: null, desired: null, ackDigest: null, lastSyncAt: null, needsReview: false, error: null, validationPath: null, failures: 0 });

export function createSyncStorage(indexedDB = globalThis.indexedDB) {
  let opening;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('workout-life-sync-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('connection');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opening = null; reject(new Error('storage')); };
      request.onblocked = () => { opening = null; reject(new Error('storage')); };
    });
    return opening;
  }
  return {
    async read() {
      const database = await open();
      return new Promise((resolve, reject) => {
        const request = database.transaction('connection', 'readonly').objectStore('connection').get('state');
        request.onsuccess = () => resolve(request.result || blank());
        request.onerror = () => reject(new Error('storage'));
      });
    },
    async update(change) {
      const database = await open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction('connection', 'readwrite');
        const store = transaction.objectStore('connection');
        let next;
        const request = store.get('state');
        request.onsuccess = () => {
          try { const current = request.result || blank(); next = change(current); if (next !== current) store.put(next, 'state'); }
          catch { transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(next);
        transaction.onerror = transaction.onabort = () => reject(new Error('storage'));
      });
    },
  };
}

export class WorkoutSync {
  constructor({ storage = createSyncStorage(), readSource, fetch = globalThis.fetch.bind(globalThis),
    digest = snapshotDigest, uuid = () => crypto.randomUUID(), now = () => Date.now(),
    online = () => globalThis.navigator?.onLine !== false, onStatus = () => {},
    delay = 450, setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = id => globalThis.clearTimeout(id) } = {}) {
    Object.assign(this, { storage, readSource, fetch, digest, uuid, now, online, onStatus, delay, setTimer, clearTimer });
    this.sequence = 0; this.timer = null; this.sending = null; this.pairing = null;
  }

  publicStatus(state) {
    return { connected: Boolean(state.token), pairing: Boolean(state.pair),
      pending: Boolean(state.pending || (state.token && state.desired?.digest !== state.ackDigest)),
      lastSyncAt: state.lastSyncAt, needsReview: state.needsReview, error: state.error,
      validationPath: state.error === 'bad_data' ? safeValidationPath(state.validationPath) : null,
      sending: Boolean(this.sending || this.pairing), online: this.online() };
  }
  emit(state) { this.onStatus(this.publicStatus(state)); return state; }
  async status() { const state = await this.storage.read(); return this.publicStatus(state); }
  async update(change) { return this.emit(await this.storage.update(change)); }
  schedule(delay = this.delay) {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.resume().catch(error => this.onStatus({ error: error?.message === 'storage' ? 'storage' : 'unavailable' })); }, delay);
  }
  cancelTimer() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }

  async request(path, body, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetch(LIFE_ORIGIN + path, { method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: controller.signal });
      let data; try { data = await response.json(); } catch { data = null; }
      return { status: response.status, ok: response.ok, data };
    } finally { clearTimeout(timeout); }
  }

  async start() { await this.resume(); }
  async connect(code) {
    const normalized = String(code || '').trim();
    if (!normalized || normalized.length > 512) throw new Error('연결 코드를 확인해 주세요.');
    await this.update(state => {
      if (state.pair?.code === normalized) return state;
      return { ...blank(), pair: { code: normalized, deviceId: this.uuid(), expiresAt: this.now() + 10 * 60 * 1000 } };
    });
    if (this.pairing) await this.pairing;
    return this.resume();
  }
  async disconnect() {
    this.cancelTimer(); this.sequence++;
    await this.update(() => blank());
  }

  async exchange() {
    if (this.pairing) return this.pairing;
    this.pairing = this.exchangeOnce().finally(() => { this.pairing = null; });
    return this.pairing;
  }
  async exchangeOnce() {
    const state = await this.storage.read(), pair = state.pair;
    if (!pair || !this.online()) return;
    if (pair.expiresAt <= this.now()) {
      await this.update(current => current.pair?.deviceId === pair.deviceId ? { ...current, pair: null, error: 'expired_code' } : current); return;
    }
    let result;
    try { result = await this.request('/api/source/connect', { source: 'workout-log', code: pair.code, deviceId: pair.deviceId }); }
    catch {
      await this.update(current => current.pair?.deviceId === pair.deviceId ? { ...current, error: 'network' } : current);
      this.schedule(3000); return;
    }
    if (result.ok && result.data?.ok === true && typeof result.data.token === 'string' && result.data.token
      && result.data.source === 'workout-log' && result.data.deviceId === pair.deviceId) {
      await this.update(current => current.pair?.deviceId === pair.deviceId
        ? { ...blank(), deviceId: pair.deviceId, token: result.data.token, revision: result.data.revision || 0 } : current);
    } else {
      const retry = result.status >= 500 || result.status === 429 || result.ok;
      await this.update(current => current.pair?.deviceId === pair.deviceId
        ? { ...current, pair: retry ? current.pair : null, error: retry ? 'network' : 'expired_code' } : current);
      if (retry) this.schedule(3000);
    }
  }

  async changed() {
    const order = ++this.sequence;
    const existing = await this.storage.read();
    if (!existing.token) { this.emit(existing); return; }
    const payload = projectWorkout(this.readSource());
    const serialized = JSON.stringify(payload);
    const digest = await this.digest(payload);
    if (order !== this.sequence) return;
    let superseded = false;
    const state = await this.update(current => {
      if (order !== this.sequence || !current.token || current.desired?.digest === digest) return current;
      // Another tab can commit original localStorage while this tab hashes an older snapshot.
      if (JSON.stringify(projectWorkout(this.readSource())) !== serialized) { superseded = true; return current; }
      const rejected = REJECTED_PAYLOAD.includes(current.error) && current.pending?.digest !== digest;
      return { ...current, desired: { payload, digest }, ...(rejected ? { pending: null, error: null, validationPath: null } : {}) };
    });
    if (superseded) return this.changed();
    if (state.token && (!state.error || state.error === 'network') && state.desired?.digest !== state.ackDigest) this.schedule();
  }
  async resume({ retryRejected = false } = {}) {
    await this.exchange();
    const state = await this.storage.read();
    if (!state.token) { this.emit(state); return; }
    await this.changed(); // Recover a source write made immediately before the previous app process closed.
    // Automatic retries stay blocked for an unchanged invalid payload. An
    // explicit "send now" can request fresh validation after an app/server patch.
    if (retryRejected) await this.update(current => current.error === 'bad_data'
      ? { ...current, error: null, validationPath: null } : current);
    return this.flush();
  }
  async flush() {
    if (this.sending) return this.sending;
    this.cancelTimer();
    this.sending = this.sendLoop().finally(async () => { this.sending = null; this.emit(await this.storage.read()); });
    return this.sending;
  }
  async sendLoop() {
    if (!this.online()) { this.emit(await this.storage.read()); return; }
    for (let count = 0; count < 20; count++) {
      const state = await this.update(current => {
        if (!current.token || blocksSending(current.error) || current.pending
          || !current.desired || current.desired.digest === current.ackDigest) return current;
        const revision = current.revision + 1;
        if (!Number.isSafeInteger(revision)) return { ...current, error: 'reconnect' };
        return { ...current, revision, pending: { revision, mutationId: `${current.deviceId}:${revision}`,
          digest: current.desired.digest, payload: current.desired.payload } };
      });
      if (!state.token || !state.pending || blocksSending(state.error)) return;
      const request = state.pending;
      let result;
      try { result = await this.request('/api/source/snapshot', { deviceId: state.deviceId, revision: request.revision,
        mutationId: request.mutationId, payload: request.payload }, state.token); }
      catch { result = { ok: false, status: 0, data: null }; }
      const same = current => current.deviceId === state.deviceId && current.token === state.token && current.pending?.mutationId === request.mutationId;
      if (result.ok && result.data?.ok === true && result.data.revision === request.revision) {
        await this.update(current => same(current) ? { ...current, pending: null, ackDigest: request.digest,
          lastSyncAt: this.now(), needsReview: result.data.needsReview === true, error: null, validationPath: null, failures: 0 } : current);
        continue;
      }
      if (result.status === 409 && result.data?.code === 'stale_revision' && Number.isSafeInteger(result.data.revision)
        && result.data.revision >= request.revision) {
        await this.update(current => same(current) ? { ...current, pending: null, ackDigest: null,
          revision: Math.max(current.revision, result.data.revision), error: null } : current);
        continue;
      }
      const error = result.status === 409 && result.data?.code === 'empty_initial_snapshot' ? 'empty_initial_snapshot'
        : result.status === 409 && result.data?.code === 'record_conflict' ? 'network'
        : result.status === 401 || result.status === 403 || result.status === 409 ? 'reconnect'
        : result.status === 413 ? 'too_large' : result.status === 400 || result.status === 422 ? 'bad_data' : 'network';
      const validationPath = error === 'bad_data' ? safeValidationPath(result.data?.validationPath) : null;
      const next = await this.update(current => same(current) ? { ...current, error, validationPath, failures: current.failures + 1 } : current);
      if (same(next) && REJECTED_PAYLOAD.includes(error) && next.desired?.digest !== request.digest) {
        await this.update(current => same(current) ? { ...current, pending: null, error: null, validationPath: null } : current);
        continue;
      }
      if (same(next) && error === 'network') this.schedule(Math.min(60000, 1000 * 2 ** Math.min(next.failures, 6)));
      return;
    }
    this.schedule();
  }
}
