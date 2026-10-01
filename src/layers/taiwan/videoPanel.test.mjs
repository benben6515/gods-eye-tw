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
