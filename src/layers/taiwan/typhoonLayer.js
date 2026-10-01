import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';

export const TAIWAN_TYPHOON_OVERLAY_SOURCE_ID = 'taiwan-typhoon';
export const TAIWAN_TYPHOON_TRACK_ID = 'taiwan-typhoon:track';
export const TAIWAN_TYPHOON_CENTER_ID = 'taiwan-typhoon:center';
const OFFLINE_MESSAGE = '未連線後端 · 自動重試中';
const QUIET_MESSAGE = '目前無颱風警報';

/** Create the source-owned presentation for the storm-center ambient label. */
export function createTyphoonOverlayEntry({ position, name, accent }) {
  return {
    id: TAIWAN_TYPHOON_CENTER_ID,
    position,
    variant: 'label',
    title: name,
    accent,
    priority: 10_000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * 颱風路徑 — one active typhoon's center and track through the Taiwan
 * backend. When the backend reports `{ active: false }` the section clears
 * the globe and the panel reads 目前無颱風警報.
 * @param {object} [options]
 * @param {object} options.source Snapshot source ({ getSnapshot }).
 * @param {object} [options.overlayHost] World overlay host for the label.
 * @param {object} [options.cesium] Cesium namespace override (tests).
 */
export function createTaiwanTyphoonLayer({
  source,
  overlayHost,
  cesium = Cesium,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Taiwan typhoon layer requires a snapshot source');
  const ACCENT = cesium.Color.fromCssColorString('#7fe6ed');
  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let destroyed = false;
  let rowControlsListener = null;
  let snapshot = { active: false };
  let loading = false;
  let offline = false;
  let lastUpdate = null;

  const notify = () => rowControlsListener?.();
  const current = () => (snapshot.active ? snapshot : null);
  const center = () => {
    const storm = current();
    return storm?.track.length ? storm.track[storm.track.length - 1] : null;
  };

  function clearOverlay() {
    overlayHost?.clearSource(TAIWAN_TYPHOON_OVERLAY_SOURCE_ID);
    overlayHost?.setVisible(TAIWAN_TYPHOON_OVERLAY_SOURCE_ID, false);
  }

  function rebuild() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    const storm = current();
    if (!storm || !storm.track.length) {
      clearOverlay();
      return;
    }
    const positions = storm.track.map((point) =>
      cesium.Cartesian3.fromDegrees(point.lon, point.lat),
    );
    dataSource.entities.add(
      new cesium.Entity({
        id: TAIWAN_TYPHOON_TRACK_ID,
        polyline: {
          positions,
          width: 3,
          material: new cesium.PolylineDashMaterialProperty({
            color: ACCENT.withAlpha(0.9),
            dashLength: 16,
          }),
          clampToGround: true,
        },
      }),
    );
    const last = center();
    const lastPosition = cesium.Cartesian3.fromDegrees(last.lon, last.lat);
    dataSource.entities.add(
      new cesium.Entity({
        id: TAIWAN_TYPHOON_CENTER_ID,
        position: lastPosition,
        point: {
          pixelSize: 14,
          color: ACCENT.withAlpha(0.95),
          outlineColor: cesium.Color.WHITE.withAlpha(0.9),
          outlineWidth: 2,
          heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
    if (enabled && overlayHost) {
      overlayHost.setEntries(TAIWAN_TYPHOON_OVERLAY_SOURCE_ID, [
        createTyphoonOverlayEntry({
          position: lastPosition,
          name: snapshot.name,
          accent: ACCENT.toCssColorString(),
        }),
      ]);
      overlayHost.setVisible(TAIWAN_TYPHOON_OVERLAY_SOURCE_ID, true);
    }
  }

  const layer = {
    id: 'taiwan-typhoon',
    name: '颱風路徑',
    icon: '🌀',
    source: 'CWA · Taiwan backend',
    updateInterval: 600_000,

    init(nextViewer) {
      if (viewer)
        throw new Error('Taiwan typhoon layer is already initialized');
      viewer = nextViewer;
      dataSource = new cesium.CustomDataSource('taiwan-typhoon');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      console.log('[Data:TaiwanTyphoon] Initialized');
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      registerPickOwner(
        'taiwan-typhoon',
        (id) =>
          enabled &&
          (id === TAIWAN_TYPHOON_TRACK_ID || id === TAIWAN_TYPHOON_CENTER_ID),
      );
      rebuild();
      notify();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      offline = false;
      unregisterPickOwner('taiwan-typhoon');
      clearOverlay();
      if (dataSource) {
        dataSource.entities.removeAll();
        dataSource.show = false;
      }
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
        const next = await source.getSnapshot({ signal: controller.signal });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        snapshot = next;
        offline = false;
        lastUpdate = Date.now();
        rebuild();
        console.log(
          snapshot.active
            ? `[Data:TaiwanTyphoon] Active: ${snapshot.name} (${snapshot.track.length} track points)`
            : '[Data:TaiwanTyphoon] No active typhoon warning',
        );
        return true;
      } catch {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        // Handled steady state: keep the last good render, surface 未連線後端.
        offline = true;
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
      if (destroyed || params.focus !== true) return;
      const storm = current();
      const point = center();
      if (!storm || !point || !viewer || viewer.isDestroyed?.()) return;
      const sphere = cesium.BoundingSphere.fromPoints([
        cesium.Cartesian3.fromDegrees(point.lon, point.lat),
      ]);
      sphere.radius = 600_000;
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
          ? 0
          : 1.4,
      });
    },

    getRowControls() {
      const storm = current();
      const point = center();
      const detail = offline
        ? OFFLINE_MESSAGE
        : loading
          ? '連線中…'
          : storm
            ? `${storm.name} · ${storm.track.length} 個路徑點`
            : QUIET_MESSAGE;
      return {
        list: null,
        chips: storm
          ? [
              {
                id: 'focus',
                label: '飛往颱風中心',
                title: '移動相機到目前中心位置',
                params: { focus: true },
              },
            ]
          : [],
        legend: storm
          ? [
              { label: '颱風路徑', color: ACCENT.toCssColorString() },
              { label: '目前中心位置', color: '#ffffff' },
            ]
          : [],
        info: storm
          ? `${snapshot.name}
警報時間 ${storm.issuetime || '未知'}${point ? `\n中心 ${point.lat.toFixed(1)}°N ${point.lon.toFixed(1)}°E · 氣壓 ${point.pressure != null ? `${Math.round(point.pressure)} hPa` : '未知'} · 最大風速 ${point.maxWind != null ? `${Math.round(point.maxWind)} m/s` : '未知'}` : ''}`
          : `${detail}
資料來源：交通部中央氣象署（經台灣後端轉介）`,
        infoTitle:
          '中央氣象署颱風警報路徑（經台灣後端轉介）。無警報時此圖層保持淨空；有警報時顯示路徑與目前中心位置。',
      };
    },

    setRowControlsListener(value) {
      rowControlsListener = typeof value === 'function' ? value : null;
    },

    getStats() {
      const storm = current();
      return {
        count: storm ? storm.track.length : 0,
        lastUpdate,
        loading,
        source: 'CWA · Taiwan backend',
        status: offline ? 'idle' : 'nominal',
        statusMessage: offline ? OFFLINE_MESSAGE : undefined,
        ...(storm ? { name: storm.name } : {}),
      };
    },

    getDiagnostics() {
      return {
        enabled,
        loading,
        offline,
        active: snapshot.active,
        trackPoints: current()?.track.length || 0,
      };
    },

    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      if (dataSource && viewer && !viewer.isDestroyed?.()) {
        viewer.dataSources.remove(dataSource, true);
      }
      dataSource = null;
      viewer = null;
      snapshot = { active: false };
      rowControlsListener = null;
    },
  };
  return layer;
}
