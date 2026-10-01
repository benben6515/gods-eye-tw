import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { pickEntityId } from './picking.js';
import {
  createEarthquakeOverlayEntry,
  depthColor,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  selectEarthquakeOverlayCohort,
} from '../earthquakes/model.js';

export const TAIWAN_QUAKE_OVERLAY_SOURCE_ID = 'taiwan-quake';
const ENTITY_ID_PREFIX = 'taiwan-quake:';
const OFFLINE_MESSAGE = '未連線後端 · 自動重試中';

const pad = (value) => String(value).padStart(2, '0');
const formatTime = (ms) => {
  if (!Number.isFinite(ms)) return '時間未知';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * 台灣地震 — CWA significant earthquakes through the Taiwan backend, rendered
 * on the existing earthquake display path (magnitude-scaled discs, depth-band
 * colors, ambient magnitude labels) plus 最大震度 in the selection readout and
 * fly-to on click.
 * @param {object} [options]
 * @param {object} options.source Snapshot source ({ getSnapshot }).
 * @param {object} [options.overlayHost] World overlay host for labels.
 * @param {object} [options.cesium] Cesium namespace override (tests).
 */
export function createTaiwanQuakeLayer({
  source,
  overlayHost,
  cesium = Cesium,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openLink = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Taiwan quake layer requires a snapshot source');
  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let clickHandler = null;
  let rowControlsListener = null;
  let destroyed = false;
  let quakes = [];
  let loading = false;
  let offline = false;
  let stale = false;
  let lastUpdate = null;
  let selectedId = null;

  const notify = () => rowControlsListener?.();
  const byId = (id) => quakes.find((quake) => quake.id === id) || null;

  function setSelection(id, { focus = false } = {}) {
    const quake = id ? byId(id) : null;
    selectedId = quake ? quake.id : null;
    if (focus && quake && viewer && !viewer.isDestroyed?.()) {
      const radius = Math.max(12_000, Math.pow(2, quake.magnitude) * 2_500);
      const center = cesium.BoundingSphere.fromPoints([
        cesium.Cartesian3.fromDegrees(quake.lon, quake.lat),
      ]);
      center.radius = radius;
      viewer.camera.flyToBoundingSphere(center, {
        duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
          ? 0
          : 1.4,
      });
    }
    notify();
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
      const id = pickEntityId(picked, ENTITY_ID_PREFIX);
      if (id) {
        setSelection(id, { focus: true });
        return;
      }
      // Empty space clears the selection; another layer's pick is left alone.
      if (picked) setSelection(null);
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    const owner = clickHandler;
    clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  function rebuild() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    const entries = [];
    for (const quake of quakes) {
      const position = cesium.Cartesian3.fromDegrees(quake.lon, quake.lat);
      const baseRadius = Math.pow(2, quake.magnitude) * 1000;
      const color = depthColor(quake.depthKm || 0);
      const isSignificant = quake.magnitude >= 5.0;
      dataSource.entities.add(
        new cesium.Entity({
          id: `${ENTITY_ID_PREFIX}${quake.id}`,
          position,
          ellipse: {
            semiMajorAxis: baseRadius,
            semiMinorAxis: baseRadius,
            material: new cesium.ColorMaterialProperty(
              color.withAlpha(isSignificant ? 0.4 : 0.3),
            ),
            outline: true,
            outlineColor: color.withAlpha(isSignificant ? 1.0 : 0.8),
            outlineWidth: isSignificant ? 3 : 2,
            heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            magnitude: quake.magnitude,
            maxIntensity: quake.maxIntensity,
            location: quake.location,
            time: quake.time,
            depthKm: quake.depthKm,
          },
        }),
      );
      entries.push(
        createEarthquakeOverlayEntry({
          id: quake.id,
          position,
          magnitude: quake.magnitude,
          accent: color.toCssColorString(),
        }),
      );
    }
    if (enabled && overlayHost) {
      overlayHost.setEntries(
        TAIWAN_QUAKE_OVERLAY_SOURCE_ID,
        selectEarthquakeOverlayCohort(entries),
        { cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT, moving: false },
      );
    }
  }

  const layer = {
    id: 'taiwan-quake',
    name: '台灣地震',
    icon: '💥',
    source: 'CWA · Taiwan backend',
    updateInterval: 120_000,

    init(nextViewer) {
      if (viewer) throw new Error('Taiwan quake layer is already initialized');
      viewer = nextViewer;
      dataSource = new cesium.CustomDataSource('taiwan-quake');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      console.log('[Data:TaiwanQuake] Initialized');
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost?.setVisible(TAIWAN_QUAKE_OVERLAY_SOURCE_ID, true);
      registerPickOwner(
        'taiwan-quake',
        (id) => enabled && String(id).startsWith(ENTITY_ID_PREFIX),
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
      unregisterPickOwner('taiwan-quake');
      removeClickHandler();
      overlayHost?.clearSource(TAIWAN_QUAKE_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible(TAIWAN_QUAKE_OVERLAY_SOURCE_ID, false);
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
        const rows = await source.getSnapshot({ signal: controller.signal });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        quakes = rows;
        stale = false;
        offline = false;
        lastUpdate = Date.now();
        rebuild();
        console.log(`[Data:TaiwanQuake] Updated: ${rows.length} events`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        // An unreachable or malformed backend is a handled steady state, not a
        // fault to log: keep the last good render and surface 未連線後端.
        offline = true;
        stale = quakes.length > 0;
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
      if (params.clear === true || params.quakeId === null) {
        setSelection(null);
        return;
      }
      if (typeof params.quakeId === 'string' && byId(params.quakeId)) {
        setSelection(params.quakeId, { focus: params.focus === true });
      }
      if (params.report === true) {
        const quake = selectedId ? byId(selectedId) : null;
        if (quake?.reportUrl) openLink(quake.reportUrl);
      }
    },

    getRowControls() {
      const selected = selectedId ? byId(selectedId) : null;
      const detail = selected
        ? `${selected.location || '位置未知'} · ${formatTime(selected.time)}`
        : quakes.length
          ? `最近 ${quakes.length} 則顯著地震`
          : offline
            ? OFFLINE_MESSAGE
            : loading
              ? '連線中…'
              : '尚無資料';
      return {
        list: {
          ariaLabel: '台灣顯著地震列表',
          items: quakes.slice(0, 20).map((quake, index) => ({
            id: quake.id,
            ordinal: index + 1,
            lead: `M${quake.magnitude.toFixed(1)}`,
            text: `${quake.location || '位置未知'}${quake.maxIntensity ? ` · 震度 ${quake.maxIntensity}` : ''}`,
            active: quake.id === selectedId,
            params: { quakeId: quake.id, focus: true },
          })),
        },
        chips: selected?.reportUrl
          ? [
              {
                id: 'report',
                label: '地震報告 ↗',
                title: '在瀏覽器開啟這起地震的中央氣象署報告',
                onClick: () => openLink(selected.reportUrl),
              },
            ]
          : [],
        legend: [],
        info: selected
          ? `${selected.location || '位置未知'}
規模 M${selected.magnitude.toFixed(1)}${selected.maxIntensity ? ` · 最大震度 ${selected.maxIntensity}` : ''}
深度 ${selected.depthKm != null ? `${Math.round(selected.depthKm)} 公里` : '未知'}
發震時間 ${formatTime(selected.time)}`
          : `${detail}
清單與地圖事件皆可選取並飛往該位置。`,
        infoTitle:
          '交通部中央氣象署顯著地震（經台灣後端轉介）。清單按發報順序排列；最大震度為該起地震的觀測最大震度。',
      };
    },

    setRowControlsListener(value) {
      rowControlsListener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: quakes.length,
        lastUpdate,
        loading,
        stale,
        source: 'CWA · Taiwan backend',
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
        count: quakes.length,
        selectedId,
        clickHandlerActive: clickHandler !== null,
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
      quakes = [];
      rowControlsListener = null;
    },
  };
  return layer;
}
