import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTaiwanVideo, createTaiwanCctvVideoPanel } from './videoPanel.js';

function fakeVideo() {
  const listeners = new Map();
  return {
    listeners,
    paused: true,
    src: null,
    muted: true,
    autoplay: false,
    playsInline: false,
    bufferLength: 0,
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((f) => f !== fn),
      );
    },
    dispatch(type) {
      for (const fn of listeners.get(type) || []) fn();
    },
    pause() {
      this.paused = true;
    },
    load() {},
    removeAttribute(name) {
      this[name] = null;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    canPlayType() {
      return '';
    },
  };
}

/** Drive attachTaiwanVideo with a fake hls module graph. */
function fakeHlsHarness() {
  const log = { instances: 0, sources: [], destroyed: 0, errors: [] };
  class FakeHls {
    static isSupported() {
      return true;
    }
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    static Events = { ERROR: 'error' };
    constructor() {
      log.instances += 1;
    }
    on(event, handler) {
      log.errors.push(handler);
    }
    attachMedia(video) {
      log.video = video;
    }
    loadSource(url) {
      log.sources.push(url);
    }
    recoverMediaError() {
      log.recovered = true;
    }
    destroy() {
      log.destroyed += 1;
    }
  }
  return { FakeHls, log };
}

test('attachTaiwanVideo routes .m3u8 through hls.js and disposes cleanly', async () => {
  const { FakeHls, log } = fakeHlsHarness();
  const video = fakeVideo();
  const playback = attachTaiwanVideo(video, 'https://cctv.example/live.m3u8', {
    loadHls: async () => ({ default: FakeHls }),
  });
  await playback.ready;
  assert.equal(log.instances, 1);
  assert.equal(log.sources[0], 'https://cctv.example/live.m3u8');
  playback.dispose();
  assert.equal(log.destroyed, 1, 'dispose destroys the decoder exactly once');
});

test('non-HLS URLs use the native video source path', async () => {
  const { FakeHls, log } = fakeHlsHarness();
  const video = fakeVideo();
  const playback = attachTaiwanVideo(video, 'https://cctv.example/frame.jpg', {
    loadHls: async () => ({ default: FakeHls }),
  });
  await playback.ready;
  assert.equal(log.instances, 0, 'no decoder is constructed');
  assert.equal(video.src, 'https://cctv.example/frame.jpg');
  playback.dispose();
});

test('fatal decoder errors surface through onFailure after bounded retries', async () => {
  const { FakeHls, log } = fakeHlsHarness();
  const video = fakeVideo();
  const timers = [];
  let failures = 0;
  const playback = attachTaiwanVideo(video, 'https://cctv.example/live.m3u8', {
    loadHls: async () => ({ default: FakeHls }),
    onFailure: () => {
      failures += 1;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  });
  await playback.ready;
  const errorHandler = log.errors[0];
  errorHandler(null, { fatal: true, type: 'networkError' });
  assert.equal(failures, 0, 'first fatal error schedules a retry');
  for (const fn of timers.splice(0)) fn();
  errorHandler(null, { fatal: true, type: 'networkError' });
  for (const fn of timers.splice(0)) fn();
  errorHandler(null, { fatal: true, type: 'networkError' });
  assert.equal(failures, 1, 'the third fatal error gives up');
  assert.equal(log.destroyed, 1);
});

test('the panel replaces cameras, reports missing streams, and releases its DOM', () => {
  const created = [];
  const document = {
    createElement(tag) {
      const node = {
        tag,
        children: [],
        style: {},
        hidden: false,
        textContent: '',
        append(...kids) {
          this.children.push(...kids);
        },
        remove() {
          this.removed = true;
        },
        setAttribute() {},
        removeAttribute() {},
        load() {},
        addEventListener() {},
        removeEventListener() {},
      };
      created.push(node);
      return node;
    },
  };
  const panel = createTaiwanCctvVideoPanel({
    document,
    container: { appendChild() {} },
    attachVideo: () => ({ dispose: () => {} }),
  });
  panel.open({
    id: 'A1',
    name: '市民大道',
    road: '市民大道',
    direction: '東向',
    mile: null,
    videoUrl: 'https://cctv.example/live.m3u8',
  });
  assert.equal(panel.isOpen(), true);
  panel.open({
    id: 'A2',
    name: '無直播',
    videoUrl: null,
  });
  assert.equal(
    panel.isOpen(),
    true,
    'the panel stays open for the replacement',
  );
  const statusNode = created.find(
    (node) => node.tag === 'div' && node.style.display === 'block',
  );
  assert.match(statusNode?.textContent || '', /未提供直播網址/);
  panel.close();
  assert.equal(panel.isOpen(), false);
  panel.destroy();
  assert.equal(
    created.some((node) => node.removed),
    true,
    'destroy removes the panel root',
  );
});

/** Panel harness with node:test-friendly fakes for the resolve flow. */
function createResolveHarness({ resolveStream }) {
  const created = [];
  const document = {
    createElement(tag) {
      const node = {
        tag,
        children: [],
        style: {},
        hidden: false,
        textContent: '',
        append(...kids) {
          this.children.push(...kids);
        },
        remove() {
          this.removed = true;
        },
        setAttribute() {},
        removeAttribute() {},
        load() {},
        addEventListener() {},
        removeEventListener() {},
      };
      created.push(node);
      return node;
    },
  };
  const attached = [];
  const timers = [];
  const panel = createTaiwanCctvVideoPanel({
    document,
    container: { appendChild() {} },
    attachVideo: (_video, url) => {
      attached.push(url);
      return { dispose: () => {} };
    },
    resolveStream,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  const root = () =>
    created.find((node) => node.tag === 'div' && node.className === 'taiwan-cctv-panel');
  const statusNode = () => root()?.children[3];
  const flushTimers = () => {
    for (const fn of timers.splice(0)) fn();
  };
  return { panel, attached, timers, flushTimers, statusNode };
}

test('transcoder-backed cameras resolve through the backend before attaching', async () => {
  const resolveCalls = [];
  const { panel, attached, statusNode } = createResolveHarness({
    resolveStream: async ({ id }) => {
      resolveCalls.push(id);
      return { status: 'ready', url: 'https://hls.bote.gov.taipei/hls/001/7780/index.m3u8' };
    },
  });

  panel.open({
    id: '001',
    name: '市民大道一段',
    videoUrl: 'https://hls.bote.gov.taipei/live/index.html?id=001',
  });
  assert.equal(attached.length, 0, 'no attach before resolution completes');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resolveCalls, ['001']);
  assert.deepEqual(attached, ['https://hls.bote.gov.taipei/hls/001/7780/index.m3u8']);
  assert.equal(statusNode().style.display, 'none', 'status clears once attached');
  panel.close();
});

test('converting cameras surface progress and auto-retry until ready', async () => {
  let calls = 0;
  const { panel, attached, flushTimers, statusNode } = createResolveHarness({
    resolveStream: async () => {
      calls += 1;
      return calls < 3
        ? { status: 'converting', retryAfterSeconds: 2 }
        : { status: 'ready', url: 'https://hls.example/ready.m3u8' };
    },
  });

  panel.open({ id: '002', name: '環河快速道路', videoUrl: 'https://hls.example/player.html?id=002' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.match(statusNode().textContent || '', /串流喚醒中/);

  flushTimers();
  await new Promise((resolve) => setImmediate(resolve));
  flushTimers();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 3, 'retried until the transcoder was ready');
  assert.deepEqual(attached, ['https://hls.example/ready.m3u8']);
  panel.close();
});

test('unavailable cameras report offline instead of retrying forever', async () => {
  const { panel, attached, statusNode } = createResolveHarness({
    resolveStream: async () => ({ status: 'unavailable', url: null }),
  });

  panel.open({ id: '003', name: '中興大橋引道', videoUrl: 'https://hls.example/player.html?id=003' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(statusNode().textContent || '', /離線或維護中/);
  assert.equal(attached.length, 0);
  panel.close();
});

test('a resolution that settles after close() must not attach or reopen', async () => {
  let release;
  const { panel, attached } = createResolveHarness({
    resolveStream: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });

  panel.open({ id: '004', name: '延遲攝影機', videoUrl: 'https://hls.example/player.html?id=004' });
  panel.close();
  release({ status: 'ready', url: 'https://hls.example/late.m3u8' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attached.length, 0, 'the stale session never attaches');
  assert.equal(panel.isOpen(), false);
  panel.destroy();
});
