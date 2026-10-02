import test from 'node:test';
import assert from 'node:assert/strict';
import { railFixture } from './railTestFixture.mjs';
import {
  createRecognition,
  mountVoiceConsole,
  voiceRecognitionSupported,
} from './voiceConsole.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fetchFake({ reply = '台北今天多雲。', ttsOk = true } = {}) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/chat/completions')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: reply } }] }),
      });
    }
    if (String(url).endsWith('/voice/tts')) {
      return ttsOk
        ? Promise.resolve({ ok: true, status: 200, blob: async () => 'BLOB' })
        : Promise.resolve({ ok: false, status: 503 });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
  return { calls, fetchImpl };
}

function audioFake({ failPlayback = false } = {}) {
  const audios = [];
  const factory = () => {
    const audio = {
      src: '',
      onended: null,
      onerror: null,
      play: null,
    };
    audio.play = () =>
      new Promise((resolve, reject) => {
        if (failPlayback) {
          reject(new Error('playback blocked'));
          return;
        }
        // Macrotask: the adapter assigns onended only after play() resolves.
        setTimeout(() => {
          audio.onended?.();
          resolve();
        }, 0);
      });
    audios.push(audio);
    return audio;
  };
  return { factory, audios };
}

function mount(f, { audio = null, ...rest } = {}) {
  const { fetchImpl } = fetchFake(rest);
  const handle = mountVoiceConsole(f.container, {
    apiBase: 'https://api.example',
    fetchImpl,
    document: f.document,
    audioFactory: audio ? audio.factory : null,
    getRecognitionCtor: () => null, // STT unsupported → text-only path
    objectUrl: () => 'blob:fake',
    ...rest,
  });
  return handle;
}

test('voiceRecognitionSupported detects constructors without trusting shapes', () => {
  assert.equal(voiceRecognitionSupported({ SpeechRecognition: function F() {} }), true);
  assert.equal(voiceRecognitionSupported({ webkitSpeechRecognition: function G() {} }), true);
  assert.equal(voiceRecognitionSupported({}), false);
  assert.equal(voiceRecognitionSupported(null), false);
});

test('createRecognition tunes zh-TW and routes final results', () => {
  const finals = [];
  const rec = createRecognition(
    () =>
      class {
        set lang(v) {
          this._lang = v;
        }
        get lang() {
          return this._lang;
        }
      },
    {
      onInterim: () => {},
      onFinal: (text) => finals.push(text),
    },
  );
  assert.equal(rec.lang, 'zh-TW');
  assert.equal(rec.interimResults, true);
  rec.onresult({
    resultIndex: 0,
    results: [
      { isFinal: false, '0': { transcript: '台北' } },
      { isFinal: true, '0': { transcript: '台北天氣' } },
    ],
  });
  assert.deepEqual(finals, ['台北天氣']);
  assert.equal(createRecognition(() => null, {}), null);
});

test('mount renders mic + hidden panel and is idempotent', () => {
  const f = railFixture();
  const handle = mount(f);
  assert.ok(handle);
  assert.equal(f.container.querySelector('.gev-voice-mic').textContent, '🎤 VOICE');
  assert.equal(f.container.querySelector('.gev-voice-panel').hidden, true);
  assert.equal(mount(f), null); // second mount is a no-op
});

test('mic toggles the panel; typed input drives the full ask→reply round trip', async () => {
  const f = railFixture();
  const audio = audioFake();
  const handle = mount(f, { audio });
  const { mic, panel, input, send, status } = handle.elements;

  mic.click();
  assert.equal(panel.hidden, false);
  mic.click();
  assert.equal(panel.hidden, true);
  mic.click();

  input.value = '台北天氣如何？';
  send.click();
  await flush();
  await flush();
  await flush();

  assert.equal(panel.hidden, false);
  const bubbles = handle.elements.bubbles.children;
  assert.equal(bubbles[0].className, 'gev-voice-bubble user');
  assert.equal(bubbles[0].textContent, '台北天氣如何？');
  assert.equal(bubbles[1].className, 'gev-voice-bubble reply');
  assert.equal(bubbles[1].textContent, '台北今天多雲。');
  assert.equal(status.textContent, ''); // spoke cleanly → idle clears status
  assert.equal(handle.session.state, 'idle');
});

test('TTS failure keeps the reply and surfaces the degradation notice', async () => {
  const f = railFixture();
  const handle = mount(f, { ttsOk: false });
  const { input, send, status } = handle.elements;

  input.value = '問題';
  send.click();
  await flush();
  await flush();
  await flush();

  const bubbles = handle.elements.bubbles.children;
  assert.equal(bubbles[1].className, 'gev-voice-bubble reply');
  assert.equal(status.textContent, '（語音播報不可用）');
});

test('without audioFactory the console is text-only and still completes', async () => {
  const f = railFixture();
  const handle = mount(f); // no audioFactory → speak always throws
  const { input, send, status } = handle.elements;
  input.value = '問題';
  send.click();
  await flush();
  await flush();
  await flush();
  assert.equal(handle.elements.bubbles.children.length, 2);
  assert.equal(status.textContent, '（語音播報不可用）');
});

test('chat transport failure surfaces the error in the status line', async () => {
  const f = railFixture();
  const failing = (url) =>
    Promise.resolve({ ok: false, status: 429 });
  const handle = mountVoiceConsole(f.container, {
    apiBase: 'https://api.example',
    fetchImpl: failing,
    document: f.document,
    audioFactory: null,
    getRecognitionCtor: () => null,
  });
  const { input, send, status } = handle.elements;
  input.value = '問題';
  send.click();
  await flush();
  await flush();
  assert.match(status.textContent, /429/);
});
