import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaiwanApiClient,
  taiwanApiBase,
  TaiwanBackendUnavailableError,
} from './client.js';

function fakeClock() {
  let current = 1_000_000;
  const timers = new Map();
  let nextHandle = 1;
  return {
    now: () => current,
    setTimer(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { fn, at: current + ms });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      current += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= current) {
          timers.delete(handle);
          timer.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

test('taiwanApiBase reads VITE_TAIWAN_API_BASE and falls back safely', () => {
  assert.equal(taiwanApiBase({}), 'http://localhost:3000');
  assert.equal(taiwanApiBase(undefined), 'http://localhost:3000');
  assert.equal(
    taiwanApiBase({ VITE_TAIWAN_API_BASE: 'https://tw.example.com' }),
    'https://tw.example.com',
  );
  assert.equal(
    taiwanApiBase({ VITE_TAIWAN_API_BASE: 'http://localhost:3000/' }),
    'http://localhost:3000',
  );
  assert.equal(
    taiwanApiBase({ VITE_TAIWAN_API_BASE: 'http://localhost:3000/api' }),
    'http://localhost:3000/api',
  );
  assert.equal(
    taiwanApiBase({ VITE_TAIWAN_API_BASE: 'ftp://nope' }),
    'http://localhost:3000',
  );
  assert.equal(
    taiwanApiBase({ VITE_TAIWAN_API_BASE: 'not a url' }),
    'http://localhost:3000',
  );
});

test('client fetches JSON and resets the backoff gate on success', async () => {
  const clock = fakeClock();
  const calls = [];
  const client = createTaiwanApiClient({
    base: 'http://localhost:3000',
    fetchImpl: async (url, init) => {
      calls.push({ url, signal: init.signal });
      return { ok: true, json: async () => ({ active: false }) };
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const controller = new AbortController();
  assert.deepEqual(
    await client.get('/taiwan/typhoon', { signal: controller.signal }),
    {
      active: false,
    },
  );
  assert.equal(calls[0].url, 'http://localhost:3000/taiwan/typhoon');
  assert.equal(client.getState().reachable, true);
  client.destroy();
});

test('failures open an exponential backoff gate that fails fast without network', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = createTaiwanApiClient({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await assert.rejects(
    client.get('/taiwan/quake'),
    TaiwanBackendUnavailableError,
  );
  assert.equal(calls, 1);
  assert.equal(client.getState().reachable, false);
  assert.equal(client.getState().failures, 1);

  // While the gate is open the request never reaches fetch (no console noise).
  const first = client.getState().retryAt - clock.now();
  assert.equal(first, 2_000, 'first backoff step is 2s');
  await assert.rejects(
    client.get('/taiwan/quake'),
    TaiwanBackendUnavailableError,
  );
  assert.equal(calls, 1, 'gated request skips the network');

  clock.advance(2_000);
  await assert.rejects(
    client.get('/taiwan/quake'),
    TaiwanBackendUnavailableError,
  );
  assert.equal(calls, 2);
  assert.equal(
    client.getState().retryAt - clock.now(),
    4_000,
    'backoff doubles',
  );

  clock.advance(4_000);
  client.destroy();
  assert.equal(clock.pending, 0, 'destroy releases the gate timer');

  // A success clears failures and the gate.
  const healed = createTaiwanApiClient({
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  clock.advance(60_000);
  await healed.get('/taiwan/aqi');
  assert.equal(healed.getState().reachable, true);
  healed.destroy();
});

test('a request deadline bounds a hanging backend', async () => {
  const clock = fakeClock();
  const client = createTaiwanApiClient({
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error(signal.reason?.message || 'aborted')),
        );
      }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const pending = client.get('/taiwan/quake');
  const assertion = assert.rejects(pending, TaiwanBackendUnavailableError);
  clock.advance(10_000);
  await assertion;
  assert.equal(client.getState().lastError, 'Taiwan backend request timeout');
  client.destroy();
});

test('an aborted caller signal cancels the request without counting a failure', async () => {
  const clock = fakeClock();
  const client = createTaiwanApiClient({
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(signal.reason || new Error('aborted')),
        );
      }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const controller = new AbortController();
  const assertion = assert.rejects(
    client.get('/taiwan/quake', { signal: controller.signal }),
  );
  controller.abort();
  await assertion;
  assert.equal(
    client.getState().reachable,
    true,
    'abort is not a backend fault',
  );
  client.destroy();
});
