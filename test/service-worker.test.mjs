import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const scope = 'https://crhipse.github.io/workout-log/';
function fixture() {
  const handlers = {}, deleted = [], precached = [], requested = [];
  let claimed = false;
  const cache = { addAll: async requests => { precached.push(...requests); }, put: async () => {}, match: async () => null };
  runInNewContext(script, {
    Request: class extends Request { constructor(url, options) { super(new URL(url, scope), options); } }, Response, URL,
    self: { registration: { scope }, addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting: async () => {}, clients: { claim: async () => { claimed = true; } } },
    caches: { open: async () => cache, keys: async () => ['workout-v1', 'workout-v2', 'workout-v3', 'diet-v7'], delete: async key => { deleted.push(key); } },
    fetch: async (request, options) => { requested.push({ request, options }); return new Response('current asset'); },
  });
  return { handlers, deleted, precached, requested, claimed: () => claimed };
}

test('an installed-app update bypasses the old HTTP cache and replaces only workout caches', async () => {
  const app = fixture(); let installing, activating;
  app.handlers.install({ waitUntil: promise => { installing = promise; } }); await installing;
  assert(app.precached.some(request => request.url.endsWith('/life-sync.mjs')));
  assert(app.precached.every(request => request.cache === 'reload' && request.url.startsWith(scope)));
  app.handlers.activate({ waitUntil: promise => { activating = promise; } }); await activating;
  assert.deepEqual(app.deleted, ['workout-v1', 'workout-v2']); assert(app.claimed());
});

test('asset reads revalidate HTTP caches, while other apps and automatic sync requests are never intercepted', async () => {
  const app = fixture(); let response;
  app.handlers.fetch({ request: new Request(scope + 'life-sync.mjs'), respondWith: promise => { response = promise; } });
  assert.equal(await (await response).text(), 'current asset');
  assert.equal(app.requested[0].options.cache, 'no-cache');
  const forbidden = [new Request('https://life-chronicle.crhipse.workers.dev/api/source/snapshot', { method: 'POST' }),
    new Request('https://crhipse.github.io/diet-log/app.js'),
    new Request('https://life-chronicle.crhipse.workers.dev/api/source/snapshot')];
  for (const request of forbidden) app.handlers.fetch({ request, respondWith: () => assert.fail('unrelated request intercepted') });
  assert.equal(app.requested.length, 1);
});
