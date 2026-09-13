import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutSync, projectWorkout, workoutBackup, safeValidationPath } from '../life-sync.mjs';

const initial = () => ({ version: 1, token: null, deviceId: null, revision: 0, pair: null, pending: null,
  desired: null, ackDigest: null, lastSyncAt: null, needsReview: false, error: null, failures: 0 });
class MemoryStorage {
  constructor(state = initial()) { this.value = structuredClone(state); this.turn = Promise.resolve(); }
  async read() { await this.turn; return structuredClone(this.value); }
  update(fn) { const task = this.turn.then(() => { this.value = structuredClone(fn(structuredClone(this.value))); return structuredClone(this.value); }); this.turn = task.catch(() => {}); return task; }
}
const sample = () => ({ version: 1, exercises: [{ id: 'ex1', bodyPart: '가슴', baseName: '벤치', unit: 'lb', memo: 'private-note' }],
  sets: [{ id: 's1', exId: 'ex1', date: '2026-09-13', kg: 20, reps: 8, hard: true, warmup: false, restSec: null, ts: 1 }],
  ui: { autoTimer: true, timer: { startTs: 100, endedSec: null } } });
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup({ storage = new MemoryStorage(), source = sample(), handler } = {}) {
  let record = source, nextId = 0;
  const calls = [], timers = new Map(), statuses = [];
  const fetch = async (url, options) => {
    const call = { url, options, body: JSON.parse(options.body) }; calls.push(call);
    if (handler) { const handled = await handler(call); if (handled !== undefined) return handled; }
    return url.endsWith('/connect') ? response(200, { ok: true, source: 'workout-log', deviceId: call.body.deviceId, revision: 0, token: 'source-token' })
      : response(200, { ok: true, revision: call.body.revision, changed: 1, needsReview: false });
  };
  const client = new WorkoutSync({ storage, readSource: () => record, fetch, digest: async value => JSON.stringify(value),
    uuid: () => `device-${++nextId}`, online: () => true, now: () => 100000,
    setTimer: fn => { const id = ++nextId; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id), onStatus: s => statuses.push(s) });
  return { client, storage, calls, timers, statuses, source: () => record, replace: value => { record = value; } };
}

test('projection sends only numeric fields and IDs, preserves kg, and ignores UI/name-only changes', () => {
  const source = sample(); source.token = 'secret'; source.exercises[0].apiKey = 'secret'; source.sets[0].analysis = 'secret';
  const projected = projectWorkout(source);
  assert.equal(projected.sets[0].kg, 20); assert.deepEqual(projected.exercises, [{ id: 'ex1', bodyPart: '가슴' }]);
  assert(!JSON.stringify(projected).includes('private-note')); assert(!JSON.stringify(projected).includes('secret'));
  source.exercises[0].baseName = '다른 이름'; source.ui.timer.startTs = 200;
  assert.deepEqual(projectWorkout(source), projected);
  source.exercises[0].bodyPart = '등'; assert.notDeepEqual(projectWorkout(source), projected);
  source.sets[0].restSec = null; assert.equal(projectWorkout(source).sets[0].restSec, null);
});

test('backup and restore allowlist retains original fields, excludes nested/top-level connection secrets', () => {
  const source = sample(); source.connection = { token: 'secret' }; source.ui.token = 'secret'; source.ui.timer.code = 'secret';
  source.exercises[0].token = 'secret'; source.sets[0].token = 'secret';
  const result = workoutBackup(source);
  assert(!JSON.stringify(result).includes('secret')); assert.equal(result.exercises[0].memo, 'private-note');
  assert.equal(result.ui.timer.startTs, 100); assert.equal(result.sets.length, 1);
  assert.equal(source.connection.token, 'secret'); // The source object is never mutated.
});

test('legacy sets use unchecked optional flags in the projection without changing source records or backups', () => {
  const source = sample();
  source.sets = [
    { id: 'old1', exId: 'ex1', date: '2026-08-01', kg: 20, reps: 8 },
    { id: 'old2', exId: 'ex1', date: '2026-08-02', kg: 25, reps: 6, hard: null, warmup: null, restSec: null, ts: null },
    { ...sample().sets[0], id: 'new' },
  ];
  const before = structuredClone(source), backup = workoutBackup(source);
  const projection = projectWorkout(source);
  for (const id of ['old1', 'old2']) {
    const set = projection.sets.find(row => row.id === id);
    assert.equal(set.hard, false); assert.equal(set.warmup, false);
    assert.equal(set.restSec, null); assert.equal(set.ts, null);
    assert.equal(set.kg, source.sets.find(row => row.id === id).kg);
  }
  assert.equal(projection.sets.find(row => row.id === 'new').hard, true);
  assert.deepEqual(source, before); assert.deepEqual(workoutBackup(source), backup);
  assert.equal(Object.hasOwn(backup.sets[0], 'hard'), false);
  assert.equal(backup.sets[1].hard, null);
});

test('explicit invalid flag and numeric values are not silently guessed or changed', () => {
  const source = sample(); source.sets[0].hard = 'false'; source.sets[0].warmup = 1;
  source.sets[0].kg = '20'; source.sets[0].reps = null;
  const set = projectWorkout(source).sets[0];
  assert.equal(set.hard, 'false'); assert.equal(set.warmup, 1);
  assert.equal(set.kg, '20'); assert.equal(set.reps, null);
});

test('validation diagnostics accept only bounded workout field paths, never arbitrary server text or source values', () => {
  for (const value of ['sets[0].hard', 'sets[99999].restSec', 'exercises[23].bodyPart', 'version', 'sets']) assert.equal(safeValidationPath(value), value);
  for (const value of [null, {}, 'secret-value', 'sets[0].hard: private-note', 'sets[0].token', 'sets[100000].hard', 'exercises[10000].id', 'x'.repeat(161), 'sets[0].hard\n']) assert.equal(safeValidationPath(value), null);
});

test('invalid data retains safe diagnostics, explicit send retries once, and automatic unchanged retries remain blocked', async () => {
  const fixture = setup({ handler: call => call.url.endsWith('/snapshot')
    ? response(400, { code: 'invalid_source_data', validationPath: 'sets[0].hard', error: 'private-server-text' }) : undefined });
  await fixture.client.connect('code');
  let status = await fixture.client.status();
  assert.equal(status.error, 'bad_data'); assert.equal(status.validationPath, 'sets[0].hard');
  assert(!JSON.stringify(status).includes('private-server-text'));
  const count = fixture.calls.length; await fixture.client.resume(); assert.equal(fixture.calls.length, count);
  await fixture.client.resume({ retryRejected: true });
  assert.equal(fixture.calls.length, count + 1); assert.equal(fixture.timers.size, 0);
  const sent = fixture.calls.filter(call => call.url.endsWith('/snapshot'));
  assert.equal(sent[0].options.body, sent[1].options.body);
  await fixture.client.resume(); assert.equal(fixture.calls.length, count + 1);
});

test('unsafe validation details are never persisted or exposed and later successful edits clear diagnostics', async () => {
  let invalid = true;
  const fixture = setup({ handler: call => call.url.endsWith('/snapshot') && invalid
    ? response(400, { validationPath: 'sets[0].hard: private-note' }) : undefined });
  await fixture.client.connect('code');
  assert.equal((await fixture.client.status()).validationPath, null);
  assert(!JSON.stringify(await fixture.storage.read()).includes('sets[0].hard: private-note'));
  invalid = false; fixture.source().sets[0].reps = 15;
  await fixture.client.changed(); await fixture.client.flush();
  assert.equal((await fixture.client.status()).validationPath, null);
  assert.equal((await fixture.client.status()).error, null);
});

test('startup repairs a legacy rejected snapshot and sends the full history with a fresh revision without source edits', async () => {
  const source = sample();
  source.sets.unshift({ id: 'old', exId: 'ex1', date: '2026-08-01', kg: 20, reps: 8 });
  const before = structuredClone(source);
  // This is the durable outbox produced by the previous app version: new valid
  // records could not unblock the first historical row's absent Boolean fields.
  const legacyPayload = { version: 1, exercises: [{ id: 'ex1', bodyPart: '가슴' }], sets: structuredClone(source.sets) };
  const legacyDigest = JSON.stringify(legacyPayload);
  const storage = new MemoryStorage({ ...initial(), token: 'existing-token', deviceId: 'existing-device', revision: 2,
    pending: { revision: 2, mutationId: 'existing-device:2', digest: legacyDigest, payload: legacyPayload },
    desired: { digest: legacyDigest, payload: legacyPayload }, error: 'bad_data' });
  const fixture = setup({ source, storage, handler: call => {
    assert(call.url.endsWith('/snapshot')); // No new pairing code is required.
    for (const set of call.body.payload.sets) {
      assert.equal(typeof set.hard, 'boolean'); assert.equal(typeof set.warmup, 'boolean');
    }
  } });
  await fixture.client.start();
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].body.revision, 3);
  assert.equal(fixture.calls[0].body.mutationId, 'existing-device:3');
  assert.equal(fixture.calls[0].body.payload.sets.length, 2);
  const state = await storage.read();
  assert.equal(state.token, 'existing-token'); assert.equal(state.pending, null);
  assert.equal(state.error, null); assert.equal(state.lastSyncAt, 100000);
  assert.deepEqual(source, before);
});

test('lost pairing response resumes with identical code and device after process restart', async () => {
  const first = setup({ handler: call => { if (call.url.endsWith('/connect')) throw new Error('response lost'); } });
  await first.client.connect('one-time-code');
  assert.equal(first.calls.length, 1); assert.equal(first.timers.size, 1);
  const pending = (await first.storage.read()).pair;
  const restarted = setup({ storage: first.storage }); await restarted.client.start();
  assert.deepEqual(restarted.calls[0].body, { source: 'workout-log', code: pending.code, deviceId: pending.deviceId });
  assert.equal((await first.storage.read()).pair, null); assert.equal((await first.storage.read()).revision, 1);
  assert(!JSON.stringify(restarted.statuses).includes('source-token')); assert(!JSON.stringify(restarted.statuses).includes('one-time-code'));
});

test('lost snapshot response retries an identical immutable revision/mutation/body without duplicating acknowledgement', async () => {
  let lost = true;
  const fixture = setup({ handler: call => { if (call.url.endsWith('/snapshot') && lost) { lost = false; throw new Error('response lost'); } } });
  await fixture.client.connect('code'); const waiting = (await fixture.storage.read()).pending;
  assert.equal(waiting.revision, 1); assert.equal((await fixture.storage.read()).error, 'network');
  await fixture.client.resume();
  const snapshots = fixture.calls.filter(c => c.url.endsWith('/snapshot'));
  assert.deepEqual(snapshots[0].body, snapshots[1].body); assert.equal((await fixture.storage.read()).pending, null);
  assert.equal((await fixture.storage.read()).revision, 1);
  assert.equal(snapshots[0].options.credentials, 'omit'); assert.equal(snapshots[0].options.headers.Authorization, 'Bearer source-token');
});

test('a late acknowledgement cannot remove a newer source edit; the next revision sends the latest snapshot', async () => {
  const gate = deferred(), sent = deferred(); let pause = true;
  const fixture = setup({ handler: call => { if (call.url.endsWith('/snapshot') && pause) { pause = false; sent.resolve(); return gate.promise; } } });
  const connecting = fixture.client.connect('code'); await sent.promise;
  fixture.source().sets[0].reps = 10; await fixture.client.changed();
  gate.resolve(response(200, { ok: true, revision: 1, changed: 1 })); await connecting;
  const snapshots = fixture.calls.filter(c => c.url.endsWith('/snapshot'));
  assert.deepEqual(snapshots.map(c => c.body.revision), [1, 2]);
  assert.deepEqual(snapshots.map(c => c.body.payload.sets[0].reps), [8, 10]);
  assert.equal((await fixture.storage.read()).pending, null);
});

test('restart recovers a committed source deletion even if the outbox write never ran', async () => {
  const fixture = setup(); await fixture.client.connect('code');
  fixture.source().sets = []; // App process ended after original localStorage write, before changed().
  const restarted = setup({ storage: fixture.storage, source: fixture.source() }); await restarted.client.start();
  assert.equal(restarted.calls.length, 1); assert.deepEqual(restarted.calls[0].body.payload.sets, []);
  assert.equal(restarted.calls[0].body.revision, 2);
});

test('unchanged UI saves do not allocate revisions and a reset sends a complete empty snapshot', async () => {
  const fixture = setup(); await fixture.client.connect('code');
  fixture.source().ui.autoTimer = false; fixture.source().exercises[0].unit = 'kg';
  await fixture.client.changed(); await fixture.client.flush();
  assert.equal((await fixture.storage.read()).revision, 1);
  fixture.replace({ exercises: [], sets: [], ui: {} }); await fixture.client.changed(); await fixture.client.flush();
  assert.equal((await fixture.storage.read()).revision, 2);
  assert.deepEqual(fixture.calls.at(-1).body.payload, { version: 1, exercises: [], sets: [] });
});

test('source changes while a hash is pending cannot overwrite the newest desired payload', async () => {
  const fixture = setup(); await fixture.client.connect('code');
  const firstHash = deferred(); let n = 0;
  fixture.client.digest = async value => ++n === 1 ? firstHash.promise : JSON.stringify(value);
  fixture.source().sets[0].reps = 9; const old = fixture.client.changed();
  await new Promise(resolve => setImmediate(resolve));
  fixture.source().sets[0].reps = 12; await fixture.client.changed();
  firstHash.resolve('old-digest'); await old; await fixture.client.flush();
  assert.equal(fixture.calls.at(-1).body.payload.sets[0].reps, 12);
});

test('concurrent clients share one immutable outbox instead of sending different bodies at one revision', async () => {
  const gate = deferred(), sent = deferred(); let pause = false;
  const first = setup({ handler: call => { if (call.url.endsWith('/snapshot') && pause) { sent.resolve(); return gate.promise; } } });
  await first.client.connect('code'); pause = true; first.source().sets[0].reps = 9; await first.client.changed();
  const writing = first.client.flush(); await sent.promise;
  const second = setup({ storage: first.storage, source: first.source() }); await second.client.resume();
  gate.resolve(response(200, { ok: true, revision: 2 })); await writing;
  assert.deepEqual(first.calls.at(-1).body, second.calls[0].body);
  assert.equal((await first.storage.read()).revision, 2);
});

test('401 keeps queued records, stops automatic retries, and exposes only reconnect status', async () => {
  const fixture = setup({ handler: call => call.url.endsWith('/snapshot') ? response(401, { error: 'no' }) : undefined });
  await fixture.client.connect('code'); const state = await fixture.storage.read();
  assert.equal(state.error, 'reconnect'); assert(state.pending); assert.equal(fixture.timers.size, 0);
  const n = fixture.calls.length; await fixture.client.resume(); assert.equal(fixture.calls.length, n);
});

test('a stale revision issues the latest projection under a new revision above the server high-water mark', async () => {
  let stale = true;
  const fixture = setup({ handler: call => { if (call.url.endsWith('/snapshot') && stale) { stale = false; return response(409, { code: 'stale_revision', revision: 7 }); } } });
  await fixture.client.connect('code');
  assert.deepEqual(fixture.calls.filter(c => c.url.endsWith('/snapshot')).map(c => c.body.revision), [1, 8]);
  assert.equal((await fixture.storage.read()).revision, 8);
});

test('a late response after local disconnect cannot restore credentials or a queue', async () => {
  const gate = deferred(), sent = deferred();
  const fixture = setup({ handler: call => { if (call.url.endsWith('/snapshot')) { sent.resolve(); return gate.promise; } } });
  const running = fixture.client.connect('code'); await sent.promise; await fixture.client.disconnect();
  gate.resolve(response(200, { ok: true, revision: 1 })); await running;
  const state = await fixture.storage.read(); assert.equal(state.token, null); assert.equal(state.pending, null);
  assert.equal(fixture.source().sets.length, 1);
});

test('an oversized rejected snapshot stays explicit and a smaller later edit can retry without reusing its revision', async () => {
  let tooLarge = true;
  const fixture = setup({ handler: call => { if (call.url.endsWith('/snapshot') && tooLarge) return response(413, { error: 'too large' }); } });
  await fixture.client.connect('code'); assert.equal((await fixture.storage.read()).error, 'too_large');
  assert.equal(fixture.timers.size, 0); tooLarge = false; fixture.source().sets = [];
  await fixture.client.changed(); await fixture.client.flush();
  assert.equal(fixture.calls.at(-1).body.revision, 2); assert.equal((await fixture.storage.read()).error, null);
});

test('an empty first snapshot is blocked until the original source changes, then a new revision recovers', async () => {
  const fixture = setup({ source: { exercises: [], sets: [] }, handler: call => {
    if (call.url.endsWith('/snapshot') && call.body.payload.sets.length === 0) return response(409, { code: 'empty_initial_snapshot' });
  } });
  await fixture.client.connect('code'); assert.equal((await fixture.storage.read()).error, 'empty_initial_snapshot');
  const n = fixture.calls.length; await fixture.client.resume(); assert.equal(fixture.calls.length, n);
  assert.equal(fixture.timers.size, 0);
  fixture.replace(sample()); await fixture.client.changed(); await fixture.client.flush();
  assert.equal(fixture.calls.at(-1).body.revision, 2); assert.equal((await fixture.storage.read()).error, null);
});

test('offline pairing and source edits resume without requiring another code entry', async () => {
  const fixture = setup(); fixture.client.online = () => false;
  await fixture.client.connect('code'); fixture.source().sets[0].reps = 16; await fixture.client.changed();
  assert.equal(fixture.calls.length, 0); assert((await fixture.storage.read()).pair);
  fixture.client.online = () => true; await fixture.client.resume();
  assert.equal(fixture.calls.at(-1).body.payload.sets[0].reps, 16); assert.equal((await fixture.storage.read()).pending, null);
});

test('transient record conflicts and 5xx retry the same request without asking to reconnect', async () => {
  let failures = 0;
  const fixture = setup({ handler: call => {
    if (!call.url.endsWith('/snapshot')) return;
    if (failures++ === 0) return response(409, { code: 'record_conflict' });
    if (failures === 2) return response(503, { error: 'temporary' });
  } });
  await fixture.client.connect('code'); assert.equal((await fixture.storage.read()).error, 'network');
  await fixture.client.resume(); assert.equal((await fixture.storage.read()).error, 'network');
  await fixture.client.resume(); assert.equal((await fixture.storage.read()).error, null);
  const bodies = fixture.calls.filter(call => call.url.endsWith('/snapshot')).map(call => call.options.body);
  assert.equal(new Set(bodies).size, 1);
});

test('late pairing completion cannot reconnect a device after local disconnection', async () => {
  const gate = deferred(), sent = deferred();
  const fixture = setup({ handler: call => { if (call.url.endsWith('/connect')) { sent.resolve(call.body); return gate.promise; } } });
  const connecting = fixture.client.connect('code'); const body = await sent.promise;
  await fixture.client.disconnect();
  gate.resolve(response(200, { ok: true, source: 'workout-log', deviceId: body.deviceId, token: 'source-token', revision: 0 }));
  await connecting; assert.equal((await fixture.storage.read()).token, null); assert.equal(fixture.calls.length, 1);
});

test('a stale hash from another tab cannot replace the latest stored source projection', async () => {
  const first = setup(); await first.client.connect('code');
  const hash = deferred(); let hashing = true;
  first.client.digest = async payload => hashing ? (hashing = false, hash.promise) : JSON.stringify(payload);
  first.source().sets[0].reps = 9; const old = first.client.changed();
  await new Promise(resolve => setImmediate(resolve));
  first.source().sets[0].reps = 13;
  const second = setup({ storage: first.storage, source: first.source() }); await second.client.changed();
  hash.resolve('obsolete-hash'); await old; await first.client.flush();
  assert.equal(first.calls.at(-1).body.payload.sets[0].reps, 13);
});

test('default browser timers retain the Window receiver instead of using the sync client as this', () => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  let scheduled = false, cleared = false;
  try {
    globalThis.setTimeout = function () { assert.equal(this, globalThis); scheduled = true; return 99; };
    globalThis.clearTimeout = function (id) { assert.equal(this, globalThis); assert.equal(id, 99); cleared = true; };
    const client = new WorkoutSync({ storage: new MemoryStorage(), readSource: sample });
    client.schedule(); client.cancelTimer();
    assert(scheduled && cleared);
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
});
