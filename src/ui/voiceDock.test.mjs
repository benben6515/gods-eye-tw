import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVoiceDock } from './voiceDock.js';

/**
 * Minimal DOM stub for the dock: createVoiceControl builds its UI from one
 * innerHTML template, so the stub parses `id="…"` / `class="…"` out of it and
 * registers lookup-able EventTarget nodes. Only what the dock touches.
 */
function installDom() {
  const byId = new Map();
  const byClass = new Map();

  const makeNode = (tag = 'div') => {
    const node = new EventTarget();
    Object.assign(node, {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      textContent: '',
      className: '',
      classList: {
        add() {},
        remove() {},
        contains: () => false,
        toggle() {},
      },
      appendChild(child) {
        node.children.push(child);
        return child;
      },
      insertBefore(child) {
        node.children.push(child);
        return child;
      },
      append(...nodes) {
        for (const child of nodes) node.appendChild(child);
      },
      remove() {},
      setAttribute() {},
      focus() {},
      click() {
        node.dispatchEvent(new Event('click'));
      },
      querySelector(selector) {
        if (selector.startsWith('#')) return byId.get(selector.slice(1)) ?? null;
        if (selector.startsWith('.')) return byClass.get(selector.slice(1)) ?? null;
        return null;
      },
    });
    Object.defineProperty(node, 'innerHTML', {
      set(html) {
        for (const match of html.matchAll(/id="([^"]+)"/g)) {
          const child = makeNode(match[1].includes('button') ? 'button' : 'div');
          byId.set(match[1], child);
          node.appendChild(child);
        }
        for (const match of html.matchAll(/class="([^"]+)"/g)) {
          const name = match[1].split(' ')[0];
          if (!byClass.has(name)) {
            const child = makeNode(name.includes('btn') ? 'button' : 'div');
            byClass.set(name, child);
            node.appendChild(child);
          }
        }
      },
    });
    return node;
  };

  const document = {
    getElementById: (id) => (id === 'gev-voice-control' ? null : (byId.get(id) ?? makeNode(id))),
    createElement: (tag) => makeNode(tag),
    body: makeNode('body'),
  };
  globalThis.document = document;
  return document;
}

/** Fake SpeechRecognition: tests emit events by hand. */
function recognitionFake() {
  const instances = [];
  class FakeRecognition {
    constructor() {
      this.lang = '';
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.started = false;
      instances.push(this);
    }

    start() {
      this.started = true;
    }

    stop() {
      this.stopCalled = true;
    }

    abort() {
      this.stopCalled = true;
    }

    emitResult(transcript, isFinal) {
      this.onresult?.({
        resultIndex: 0,
        results: [{ 0: { transcript }, isFinal, length: 1 }],
      });
    }

    emitEnd() {
      this.onend?.();
    }
  }
  return { Ctor: FakeRecognition, instances };
}

function audioFake() {
  return () => {
    const audio = { src: '', onended: null, onerror: null };
    audio.play = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          audio.onended?.();
          resolve();
        }, 0);
      });
    return audio;
  };
}

function fetchFake(calls) {
  return (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/chat/completions')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '帶你去看台北 101。' } }],
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
}

const settle = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
};

/** Wait until the ask pipeline settles back to idle (generous cap). */
const waitIdle = async (handle, turns = 400) => {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((r) => setImmediate(r));
    if (handle.session.state === 'idle') {
      await settle(3); // let the trailing notifications flush
      return;
    }
  }
};

function mount(overrides = {}) {
  const { Ctor, instances } = recognitionFake();
  const calls = [];
  const handle = mountVoiceDock({
    apiBase: 'https://api.example',
    fetchImpl: fetchFake(calls),
    audioFactory: audioFake(),
    getRecognitionCtor: () => Ctor,
    ...overrides,
  });
  return { handle, instances, calls };
}

test('submit waits for the final transcript flush before asking', async () => {
  installDom();
  const { handle, instances, calls } = mount();
  const { button, detail } = handle.ui;
  const chatCalls = () => calls.filter((u) => u.endsWith('/chat/completions')).length;

  button.click(); // start recording
  assert.equal(instances[0].started, true, 'recognition started');

  instances[0].emitResult('帶我去看台北', false); // interim arrives…
  button.click(); // …user submits before Chrome flushes the final
  await settle();
  assert.equal(chatCalls(), 0, 'no ask before the final transcript lands');

  instances[0].emitResult('帶我去看台北 101', true); // final flush…
  instances[0].emitEnd(); // …then onend completes the handshake
  await settle(6);
  assert.equal(chatCalls(), 1, 'ask fires exactly once after the flush');
});

test('text input drives the ask flow and clears itself', async () => {
  installDom();
  const { handle, calls } = mount();
  const { textInput, button } = handle.ui;
  const chatCalls = () => calls.filter((u) => u.endsWith('/chat/completions')).length;

  const enter = new Event('keydown');
  Object.defineProperty(enter, 'key', { value: 'Enter' });

  textInput.value = '帶我去看台北 101';
  textInput.dispatchEvent(enter);
  await waitIdle(handle);

  assert.equal(chatCalls(), 1, 'typed command asked exactly once');
  assert.equal(textInput.value, '', 'input cleared after send');

  // Busy guard: while thinking/speaking a second Enter is ignored… the
  // session returns to idle after the reply, so assert via listening state:
  textInput.value = '再加一句';
  button.click(); // start recording (listening)
  textInput.dispatchEvent(enter); // Enter while listening → cancels + asks
  await waitIdle(handle);
  assert.equal(chatCalls(), 2, 'listening state was cancelled and the text asked');
});

test('each recording gets a fresh recognition instance', async () => {
  installDom();
  const { handle, instances } = mount();
  const { button } = handle.ui;

  button.click(); // round 1
  assert.equal(instances.length, 1);
  instances[0].emitResult('帶我去 101', true);
  button.click(); // submit → flush wait
  instances[0].emitEnd(); // Chrome flushes, handshake completes, ask runs
  await waitIdle(handle);
  assert.equal(handle.session.history.length, 1, 'round 1 asked');

  button.click(); // round 2 — must build a NEW instance
  assert.equal(instances.length, 2, 'a fresh instance per recording');
  assert.equal(instances[0].onresult, null, 'old instance handlers detached');

  // A late event from the dead instance must not pollute the new session.
  instances[0].emitResult('遲到的雜訊', true);
  instances[1].emitResult('帶我去高雄', true);
  button.click(); // submit round 2 → flush wait
  instances[1].emitEnd();
  await waitIdle(handle);

  assert.equal(handle.session.history.length, 2);
  assert.equal(handle.session.history[1].user, '帶我去高雄');
});

test('quick places fly through the runner without a chat round trip', async () => {
  installDom();
  const runnerCalls = [];
  const { handle } = mount({
    runner: (name, args) => {
      runnerCalls.push([name, args]);
      return Promise.resolve({ ok: true });
    },
  });
  const row = handle.ui.root.querySelector('#gev-quick-places');
  assert.ok(row, 'the quick places row must exist');
  assert.equal(row.children.length, 6, 'six preset chips');

  row.children[0].dispatchEvent(new Event('click'));
  assert.deepEqual(runnerCalls[0], [
    'fly_to_location',
    { latitude: 25.033, longitude: 121.5654, rangeM: 1200 },
  ]);
  assert.match(handle.ui.detail.textContent, /台北 101/);

  row.children[1].dispatchEvent(new Event('click'));
  assert.deepEqual(runnerCalls[1], [
    'fly_to_location',
    { latitude: 22.605, longitude: 120.29, rangeM: 3500 },
  ]);
  assert.equal(runnerCalls.length, 2);
  await settle(2);
});

test('without a runner no quick place chips are created', () => {
  installDom();
  const { handle } = mount();
  const row = handle.ui.root.querySelector('#gev-quick-places');
  assert.ok(row, 'the row exists for layout');
  assert.equal(row.children.length, 0, 'but stays empty — no runner, no chips');
});

test('submit with nothing heard names the active voice language', async () => {
  installDom();
  const { handle, instances, calls } = mount();
  const { button, detail } = handle.ui;

  button.click();
  button.click(); // submit with nothing recognized
  instances[0].emitEnd();
  await settle();

  assert.match(detail.textContent, /語音語言：/);
  assert.equal(
    calls.filter((u) => u.endsWith('/chat/completions')).length,
    0,
    'nothing was asked',
  );
});
