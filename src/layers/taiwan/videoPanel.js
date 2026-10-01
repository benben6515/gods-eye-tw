/**
 * 台灣道路攝影 live video panel. The Delaware CCTV pack plays brokered HLS
 * through a lazily imported hls.js decoder (src/layers/cctv/videoPlayback.js);
 * Taiwan cameras expose direct public .m3u8 URLs from 交通部TDX平臺, so the
 * same decoder mechanics run client-side with no lease protocol and no
 * server-brokered fallback chain.
 *
 * One panel per layer; opening a camera replaces the previous one. Every
 * resource (decoder, timer, listeners, DOM) is released by destroy() or by
 * closing the panel.
 */

const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES = 2;
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Attach one HLS (or native-progress) stream to a <video> element.
 * Mirrors attachCctvVideo's decoder policy: bounded retries, a live-buffer
 * playbackRate governor, native HLS fallback on Safari, silent cleanup.
 */
export function attachTaiwanVideo(
  video,
  url,
  {
    loadHls = () => import('hls.js'),
    onFailure = () => {},
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    setInterval = (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval = (handle) => globalThis.clearInterval(handle),
  } = {},
) {
  let disposed = false;
  let hls = null;
  let retries = 0;
  let timer = null;
  let startup = null;
  let governor = null;
  const isHlsUrl = /\.m3u8(\?|#|$)/i.test(url || '');

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimer(timer);
    clearTimer(startup);
    clearInterval(governor);
    hls?.destroy();
    hls = null;
    video.removeEventListener('canplay', play);
    video.removeEventListener('error', fail);
    video.pause();
    video.removeAttribute('src');
    video.load();
  };

  const fail = () => {
    if (disposed) return;
    dispose();
    onFailure();
  };
  const play = () => {
    if (disposed) return;
    clearTimer(startup);
    video.play().catch(() => {});
  };

  video.addEventListener('canplay', play);
  video.addEventListener('error', fail);
  startup = setTimer(fail, STARTUP_TIMEOUT_MS);

  const ready = (async () => {
    if (!isHlsUrl) {
      video.src = url || '';
      return;
    }
    try {
      const { default: Hls } = await loadHls();
      if (disposed) return;
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
        } else fail();
        return;
      }
      hls = new Hls({
        enableWorker: true,
        maxBufferLength: 24,
        maxMaxBufferLength: 30,
        backBufferLength: 0,
        maxBufferSize: 16 * 1024 * 1024,
        liveSyncDurationCount: 3,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || !data?.fatal) return;
        if (++retries > MAX_RETRIES) {
          fail();
          return;
        }
        clearTimer(timer);
        timer = setTimer(() => {
          if (disposed) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else hls.loadSource(url);
        }, RETRY_DELAY_MS);
      });
      governor = setInterval(() => {
        if (disposed || !video.buffered?.length) return;
        const ahead =
          video.buffered.end(video.buffered.length - 1) - video.currentTime;
        video.playbackRate =
          ahead < 6 ? 0.8 : ahead < 12 ? 0.9 : ahead > 24 ? 1.05 : 1;
      }, 1000);
      hls.attachMedia(video);
      hls.loadSource(url);
    } catch {
      fail();
    }
  })();

  return { dispose, ready };
}

/**
 * Create the floating camera panel. Owns its DOM and decoder; the layer calls
 * open(camera) / close() / destroy().
 *
 * resolveStream (optional) resolves playable HLS URLs for cameras whose TDX
 * VideoStreamURL is not a direct .m3u8 — Taipei cameras sit behind an
 * on-demand transcoder, so the first open can take 10–30 seconds. The panel
 * surfaces the converting state and auto-retries until ready or a bounded
 * retry budget is spent.
 */
export function createTaiwanCctvVideoPanel({
  document = globalThis.document,
  container = document?.body,
  attachVideo = attachTaiwanVideo,
  resolveStream = null,
  attribution = '資料來源：交通部TDX平臺',
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  if (!container) throw new TypeError('A video panel container is required');
  const MAX_RESOLVE_RETRIES = 6;
  let root = null;
  let video = null;
  let playback = null;
  let titleNode = null;
  let metaNode = null;
  let statusNode = null;
  let closeButton = null;
  // Bumped on close()/open() so a stale in-flight resolution (backend calls
  // can take tens of seconds) never touches a newer panel session.
  let openToken = 0;
  let resolveTimer = null;

  const close = () => {
    openToken += 1;
    if (resolveTimer) {
      clearTimer(resolveTimer);
      resolveTimer = null;
    }
    playback?.dispose();
    playback = null;
    if (root) root.hidden = true;
    if (video) video.removeAttribute('src');
    video?.load();
  };

  const destroy = () => {
    close();
    closeButton?.removeEventListener('click', onCloseClick);
    root?.remove();
    root = null;
    video = null;
    titleNode = null;
    metaNode = null;
    statusNode = null;
    closeButton = null;
  };

  const onCloseClick = () => close();

  const showStatus = (message) => {
    statusNode.textContent = message;
    statusNode.style.display = 'block';
  };

  /** Resolve-then-attach loop for transcoder-backed cameras. */
  async function resolveAndPlay(camera, token, attempt = 0) {
    let result = null;
    try {
      result = await resolveStream({ id: camera.id, signal: undefined });
    } catch {
      result = null;
    }
    if (token !== openToken || !root || root.hidden) return;

    if (result?.status === 'ready' && result.url) {
      statusNode.style.display = 'none';
      playback = attachVideo(video, result.url, {
        onFailure: () => {
          if (!root || root.hidden) return;
          showStatus('直播連線失敗，稍後再試');
        },
      });
      return;
    }

    if (result?.status === 'converting' && attempt < MAX_RESOLVE_RETRIES) {
      showStatus('串流喚醒中，首次開台約需 10–30 秒…');
      const delay = Math.max(1, result.retryAfterSeconds || 2) * 1000;
      resolveTimer = setTimer(() => {
        resolveTimer = null;
        if (token === openToken) void resolveAndPlay(camera, token, attempt + 1);
      }, delay);
      return;
    }

    if (result?.status === 'unavailable') showStatus('攝影機離線或維護中');
    else if (result?.status === 'unsupported') showStatus('此攝影機暫不支援直接播放');
    else showStatus('直播連線失敗，稍後再試');
  }

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'taiwan-cctv-panel';
    Object.assign(root.style, {
      position: 'absolute',
      right: '16px',
      bottom: '96px',
      width: '360px',
      maxWidth: 'calc(100vw - 32px)',
      zIndex: '60',
      background: 'rgba(8, 12, 18, 0.92)',
      border: '1px solid rgba(127, 230, 237, 0.35)',
      borderRadius: '10px',
      color: '#e6f2f4',
      font: '12px/1.5 "Segoe UI", system-ui, sans-serif',
      overflow: 'hidden',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      padding: '10px 12px 6px',
    });
    titleNode = document.createElement('div');
    Object.assign(titleNode.style, {
      flex: '1',
      fontWeight: '600',
      letterSpacing: '0.02em',
    });
    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '✕';
    closeButton.setAttribute('aria-label', '關閉道路攝影');
    Object.assign(closeButton.style, {
      background: 'transparent',
      border: 'none',
      color: '#9fb7bd',
      cursor: 'pointer',
      fontSize: '14px',
      padding: '0 2px',
    });
    closeButton.addEventListener('click', onCloseClick);
    header.append(titleNode, closeButton);

    metaNode = document.createElement('div');
    Object.assign(metaNode.style, {
      padding: '0 12px 8px',
      color: '#9fb7bd',
    });

    video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    Object.assign(video.style, {
      display: 'block',
      width: '100%',
      aspectRatio: '16 / 9',
      background: '#000',
    });

    statusNode = document.createElement('div');
    Object.assign(statusNode.style, {
      padding: '8px 12px',
      color: '#ffd180',
      display: 'none',
    });

    const footer = document.createElement('div');
    footer.textContent = attribution;
    Object.assign(footer.style, {
      padding: '8px 12px',
      borderTop: '1px solid rgba(127, 230, 237, 0.2)',
      color: '#7d959b',
      fontSize: '11px',
    });

    root.append(header, metaNode, video, statusNode, footer);
    root.hidden = true;
    container.appendChild(root);
  }

  return {
    /** Open (or replace) the live stream for one normalized camera record. */
    open(camera) {
      ensureDom();
      close();
      titleNode.textContent = camera.name || camera.id;
      metaNode.textContent =
        [camera.road, camera.direction, camera.mile]
          .filter(Boolean)
          .join(' · ') || camera.id;
      statusNode.style.display = 'none';
      root.hidden = false;

      if (!camera.videoUrl) {
        showStatus('此攝影機未提供直播網址');
        return;
      }

      const isDirectHls = /\.m3u8(\?|#|$)/i.test(camera.videoUrl);
      if (isDirectHls || typeof resolveStream !== 'function') {
        playback = attachVideo(video, camera.videoUrl, {
          onFailure: () => {
            if (!root || root.hidden) return;
            showStatus('直播連線失敗，稍後再試');
          },
        });
        return;
      }

      const token = openToken;
      showStatus('正在喚醒攝影機串流…');
      void resolveAndPlay(camera, token);
    },
    isOpen() {
      return Boolean(root && !root.hidden);
    },
    close,
    destroy,
  };
}
