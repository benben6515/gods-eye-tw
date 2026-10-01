import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { pickEntityId } from './picking.js';
import { createTaiwanCctvVideoPanel } from './videoPanel.js';

export const TAIWAN_CCTV_ENTITY_ID_PREFIX = 'taiwan-cctv:';
const OFFLINE_MESSAGE = '未連線後端 · 自動重試中';

/** City chips for the TDX corridor catalog (contract: `?city=<name>`). */
export const TAIWAN_CCTV_CITIES = Object.freeze([
  Object.freeze({ id: 'Taipei', label: '臺北' }),
  Object.freeze({ id: 'NewTaipei', label: '新北' }),
  Object.freeze({ id: 'Taoyuan', label: '桃園' }),
  Object.freeze({ id: 'Taichung', label: '臺中' }),
  Object.freeze({ id: 'Tainan', label: '臺南' }),
  Object.freeze({ id: 'Kaohsiung', label: '高雄' }),
]);

/**
 * 台灣道路攝影 — TDX roadside CCTV markers over Taiwan. Clicking a marker
 * opens the floating live-video panel (HLS via hls.js, mirroring the Delaware
 * live-video approach) and flies the camera to the roadside position.
 * @param {object} [options]
 * @param {object} options.source Snapshot source ({ getSnapshot }).
 * @param {object} [options.cesium] Cesium namespace override (tests).
 * @param {object} [options.document] Document override (tests).
 * @param {Function} [options.createPanel] Panel factory override (tests).
 */
export function createTaiwanCctvLayer({
  source,
  cesium = Cesium,
  document = globalThis.document,
  container = null,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  createPanel = createTaiwanCctvVideoPanel,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Taiwan CCTV layer requires a snapshot source');
  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let destroyed = false;
  let clickHandler = null;
  let rowControlsListener = null;
  let panel = null;
  let cameras = [];
  let city = 'Taipei';
  let loading = false;
  let offline = false;
  let stale = false;
  let lastUpdate = null;
  let selectedId = null;

  const notify = () => rowControlsListener?.();
  const byId = (id) => cameras.find((camera) => camera.id === id) || null;

  function select(id, { focus = false, openVideo = true } = {}) {
    const camera = id ? byId(id) : null;
    selectedId = camera ? camera.id : null;
    if (!camera) {
      panel?.close();
    } else if (openVideo) {
      panel?.open(camera);
    }
    if (focus && camera && viewer && !viewer.isDestroyed?.()) {
      const center = cesium.BoundingSphere.fromPoints([
        cesium.Cartesian3.fromDegrees(camera.lon, camera.lat),
      ]);
      center.radius = 900;
      viewer.camera.flyToBoundingSphere(center, {
        duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
          ? 0
          : 1.4,
      });
    }
    notify();
  }

  function rebuild() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    for (const camera of cameras) {
      dataSource.entities.add(
        new cesium.Entity({
          id: `${TAIWAN_CCTV_ENTITY_ID_PREFIX}${camera.id}`,
          position: cesium.Cartesian3.fromDegrees(camera.lon, camera.lat),
          point: {
            pixelSize: selectedId === camera.id ? 12 : 8,
            color: cesium.Color.fromCssColorString('#7fe6ed').withAlpha(0.9),
            outlineColor: cesium.Color.fromCssColorString('#0a3d42'),
            outlineWidth: 1.5,
            heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            road: camera.road,
            direction: camera.direction,
            mile: camera.mile,
            videoUrl: camera.videoUrl,
          },
        }),
      );
    }
  }

  function installClickHandler() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    const owner = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler = owner;
    owner.setInputAction((click) => {
      if (!enabled || destroyed || clickHandler !== owner || !isPointerFree())
        return;
      if (!click?.position) return;
      const picked = viewer.scene.pick(click.position);
      const id = pickEntityId(picked, TAIWAN_CCTV_ENTITY_ID_PREFIX);
      if (id) {
        select(id, { focus: true });
        return;
      }
      if (picked) select(null);
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    const owner = clickHandler;
    clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  async function refreshCity(nextCity, { signal } = {}) {
    city = nextCity;
    selectedId = null;
    panel?.close();
    const rows = await source.getSnapshot({ signal, city });
    cameras = rows;
    stale = false;
    offline = false;
    lastUpdate = Date.now();
    rebuild();
    console.log(`[Data:TaiwanCctv] Updated: ${rows.length} cameras in ${city}`);
  }

  const layer = {
    id: 'taiwan-cctv',
    name: '台灣道路攝影',
    icon: '🎥',
    source: '交通部TDX平臺',
    updateInterval: 300_000,

    init(nextViewer) {
      if (viewer) throw new Error('Taiwan CCTV layer is already initialized');
      viewer = nextViewer;
      dataSource = new cesium.CustomDataSource('taiwan-cctv');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      panel = createPanel({
        document,
        container: container || viewer.container || undefined,
      });
      console.log('[Data:TaiwanCctv] Initialized');
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      registerPickOwner(
        'taiwan-cctv',
        (id) => enabled && String(id).startsWith(TAIWAN_CCTV_ENTITY_ID_PREFIX),
      );
      installClickHandler();
      notify();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      offline = false;
      stale = false;
      selectedId = null;
      unregisterPickOwner('taiwan-cctv');
      removeClickHandler();
      panel?.close();
      if (dataSource) dataSource.show = false;
      notify();
    },

    async update(_viewer, { signal } = {}) {
      if (!enabled || !dataSource || destroyed) return false;
      request?.abort();
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) controller.abort(signal.reason);
      else signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      loading = true;
      notify();
      try {
        await refreshCity(city, { signal: controller.signal });
        return true;
      } catch {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        // Handled steady state: keep the last good render, surface 未連線後端.
        offline = true;
        stale = cameras.length > 0;
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },

    setParams(params = {}) {
      if (destroyed) return;
      if (typeof params.city === 'string' && params.city !== city) {
        void layer.refreshNow(params.city).catch(() => {
          offline = true;
          stale = cameras.length > 0;
          notify();
        });
        return;
      }
      if (params.clear === true || params.cameraId === null) {
        select(null);
        return;
      }
      if (typeof params.cameraId === 'string' && byId(params.cameraId)) {
        select(params.cameraId, { focus: params.focus === true });
      }
    },

    /** Immediate city refetch, used by chips and the periodic tick alike. */
    async refreshNow(nextCity = city) {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      loading = true;
      notify();
      try {
        await refreshCity(nextCity, { signal: controller.signal });
      } finally {
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },

    getRowControls() {
      const selected = selectedId ? byId(selectedId) : null;
      const detail = selected
        ? `${selected.road || selected.name}${selected.direction ? ` · ${selected.direction}` : ''}`
        : offline
          ? OFFLINE_MESSAGE
          : loading
            ? '連線中…'
            : cameras.length
              ? `${city} · ${cameras.length} 支攝影機`
              : '選擇城市以載入道路攝影';
      return {
        list: null,
        chips: TAIWAN_CCTV_CITIES.map(({ id, label }) => ({
          id: `city-${id}`,
          label,
          active: city === id,
          disabled: loading && city !== id,
          title: `${label}道路攝影`,
          params: { city: id },
        })),
        legend: [],
        info: selected
          ? `${selected.name}
${[selected.road, selected.direction, selected.mile].filter(Boolean).join(' · ') || selected.id}
${selected.videoUrl ? '直播播放中' : '無直播網址'}
資料來源：交通部TDX平臺`
          : `資料來源：交通部TDX平臺${offline ? `\n${OFFLINE_MESSAGE}` : ''}`,
        infoTitle:
          '道路攝影即時影像（交通部TDX平臺）。點選地圖上的攝影機會開啟直播面板並飛往該位置；城市按鈕切換路網範圍。',
      };
    },

    setRowControlsListener(value) {
      rowControlsListener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: cameras.length,
        countLabel: cameras.length ? String(cameras.length) : '—',
        lastUpdate,
        loading,
        stale,
        source: '交通部TDX平臺',
        city,
        status: offline ? 'idle' : 'nominal',
        statusMessage: offline ? OFFLINE_MESSAGE : undefined,
        ...(selectedId ? { selectedId } : {}),
      };
    },

    getDiagnostics() {
      return {
        enabled,
        loading,
        offline,
        stale,
        city,
        count: cameras.length,
        panelOpen: Boolean(panel?.isOpen?.()),
        selectedId,
      };
    },

    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      panel?.destroy();
      panel = null;
      if (dataSource && viewer && !viewer.isDestroyed?.()) {
        viewer.dataSources.remove(dataSource, true);
      }
      dataSource = null;
      viewer = null;
      cameras = [];
      rowControlsListener = null;
    },
  };
  return layer;
}
