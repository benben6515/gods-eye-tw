import test from 'node:test';
import assert from 'node:assert/strict';
import { railFixture } from './railTestFixture.mjs';
import {
  decodeJwtPayload,
  ensureSiteGate,
  isTokenUsable,
  readStoredToken,
  siteAuthHeaders,
  showGateOverlay,
} from './siteGate.js';

const HOUR = 3600_000;

/** Build an unsigned-looking 3-part token with the given payload. */
function fakeToken(payload, now = Math.floor(Date.now() / 1000)) {
  const body = { scope: 'site', iat: now, ...payload };
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(body)}.sig`;
}

function storageStub() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
}

test('decodeJwtPayload reads base64url payloads and rejects junk', () => {
  const payload = decodeJwtPayload(fakeToken({ scope: 'site', exp: 9999999999 }));
  assert.equal(payload.scope, 'site');
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  assert.equal(decodeJwtPayload(null), null);
});

test('isTokenUsable requires site scope and unexpired exp', () => {
  const now = Date.now();
  assert.equal(isTokenUsable(fakeToken({ exp: Math.floor(now / 1000) + HOUR }), now), true);
  assert.equal(isTokenUsable(fakeToken({ exp: Math.floor(now / 1000) - 10 }), now), false);
  assert.equal(isTokenUsable(fakeToken({ exp: Math.floor(now / 1000) + HOUR, scope: 'other' }), now), false);
  assert.equal(isTokenUsable(fakeToken({ scope: 'site' }), now), false); // no exp
  assert.equal(isTokenUsable(null, now), false);
});

test('siteAuthHeaders attaches the bearer only for a usable token', () => {
  const good = fakeToken({ exp: Math.floor(Date.now() / 1000) + HOUR });
  assert.deepEqual(siteAuthHeaders(good), { Authorization: `Bearer ${good}` });
  assert.equal(siteAuthHeaders(fakeToken({ exp: 1 })), undefined);
  assert.equal(siteAuthHeaders(null), undefined);
});

test('ensureSiteGate resolves immediately with a usable stored token', async () => {
  const f = railFixture();
  const storage = storageStub();
  storage.setItem('gev-site-token', fakeToken({ exp: Math.floor(Date.now() / 1000) + HOUR }));
  let unlocked = false;
  await ensureSiteGate({
    apiBase: 'https://api.example',
    document: f.document,
    storage,
    fetchImpl: () => {
      throw new Error('must not fetch');
    },
    container: f.container,
    onUnlock: () => {
      unlocked = true;
    },
  });
  assert.equal(unlocked, false); // immediate resolve — no overlay, no onUnlock
  assert.equal(f.container.children.length, 0); // no overlay rendered
});

test('gate overlay: correct password stores the token and unlocks', async () => {
  const f = railFixture();
  const storage = storageStub();
  const token = fakeToken({ exp: Math.floor(Date.now() / 1000) + HOUR });
  const fetches = [];
  const done = ensureSiteGate({
    apiBase: 'https://api.example',
    document: f.document,
    storage,
    fetchImpl: (url, init) => {
      fetches.push({ url: String(url), init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ token }),
      });
    },
    container: f.container,
  });
  const input = f.container.querySelector('.gev-gate-input');
  assert.ok(input, 'overlay rendered');
  input.value = 'test-passphrase';
  // The submit button was wired via addEventListener('click').
  const button = f.container.querySelector('.gev-gate-button');
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.getItem('gev-site-token'), token);
  assert.equal(f.container.querySelector('.gev-gate'), null); // overlay removed
  assert.equal(fetches[0].url, 'https://api.example/auth/site-gate');
  assert.match(fetches[0].init.body, /test-passphrase/);
  await done; // the boot promise resolves on successful unlock
});

test('gate overlay: wrong password shows the error and keeps the gate up', async () => {
  const f = railFixture();
  const storage = storageStub();
  const done = ensureSiteGate({
    apiBase: 'https://api.example',
    document: f.document,
    storage,
    fetchImpl: () =>
      Promise.resolve({ ok: false, status: 401, json: async () => ({}) }),
    container: f.container,
    onUnlock: () => {
      throw new Error('must not unlock on failure');
    },
  });
  const input = f.container.querySelector('.gev-gate-input');
  input.value = 'bad-guy';
  f.container.querySelector('.gev-gate-button').click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(f.container.querySelector('.gev-gate-error').textContent, /存取碼錯誤/);
  assert.equal(storage.getItem('gev-site-token'), null);
  assert.ok(f.container.querySelector('.gev-gate'), 'overlay stays up');
  assert.equal(readStoredToken(storage), null);
  void done;
});

test('the hint line asks the important question', () => {
  const f = railFixture();
  showGateOverlay(f.container, {
    apiBase: 'https://api.example',
    document: f.document,
    fetchImpl: () => Promise.resolve({ ok: false, status: 401 }),
    onUnlock: () => {},
  });
  assert.equal(
    f.container.querySelector('.gev-gate-hint').textContent,
    'Are you a good god?',
  );
});
