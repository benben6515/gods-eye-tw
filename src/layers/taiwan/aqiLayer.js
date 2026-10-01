import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { aqiBand, AQI_BANDS } from './bands.js';
import { pickEntityId } from './picking.js';

export const TAIWAN_AQI_OVERLAY_SOURCE_ID = 'taiwan-aqi';
const ENTITY_ID_PREFIX = 'taiwan-aqi:';
const OFFLINE_MESSAGE = '未連線後端 · 自動重試中';
const OVERLAY_COHORT_LIMIT = 96;

/** Create the source-owned presentation for one station's ambient label. */
export function createAqiOverlayEntry({ id, position, siteName, aqi, accent }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `${siteName} ${aqi != null ? aqi : '—'}`,
    accent,
    priority: aqi != null ? aqi * 100 : 0,
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

/** Keep the worst readings, with stable identity as the tie-break. */
export function selectAqiOverlayCohort(entries, limit = OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(
    0,
    Math.min(OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * 空氣品質 — Taiwan EPA monitoring stations through the Taiwan backend,
 * colored by the standard AQI bands (綠/黃/橘/紅/紫), ambient station labels,
 * station tooltip info on selection.
 * @param {object} [options]
 * @param {object} options.source Snapshot source ({ getSnapshot }).
 * @param {object} [options.overlayHost] World overlay host for labels.
 * @param {object} [options.cesium] Cesium namespace override (tests).
 */
export function createTaiwanAqiLayer({
  source,
  overlayHost,
  cesium = Cesium,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Taiwan AQI layer requires a snapshot source');
  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let destroyed = false;
  let clickHandler = null;
  let rowControlsListener = null;
  let sites = [];
  let loading = false;
  let offline = false;
  let stale = false;
  let lastUpdate = null;
  let selectedSite = null;

  const notify = () => rowControlsListener?.();
  const findSite = (id) => sites.find((site) => site.id === id) || null;

  function select(site, { focus = false } = {}) {
    selectedSite = site;
    if (focus && site && viewer && !viewer.isDestroyed?.()) {
      const sphere = cesium.BoundingSphere.fromPoints([
        cesium.Cartesian3.fromDegrees(site.lon, site.lat),
      ]);
      sphere.radius = 25_000;
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
          ? 0
          : 1.4,
      });
    }
    notify();
  }

  function siteEntityId(site) {
    return `${ENTITY_ID_PREFIX}${site.id}`;
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
        select(findSite(id), { focus: true });
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

  function rebuild() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    const entries = [];
    for (const site of sites) {
      const band = aqiBand(site.aqi);
      const position = cesium.Cartesian3.fromDegrees(site.lon, site.lat);
      const isSelected = selectedSite && selectedSite.id === site.id;
      dataSource.entities.add(
        new cesium.Entity({
          id: siteEntityId(site),
          position,
          point: {
            pixelSize: isSelected ? 14 : 9,
            color: cesium.Color.fromCssColorString(band.color).withAlpha(0.92),
            outlineColor: cesium.Color.WHITE.withAlpha(
              isSelected ? 0.95 : 0.55,
            ),
            outlineWidth: isSelected ? 2.5 : 1.5,
            heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            siteName: site.siteName,
            county: site.county,
            aqi: site.aqi,
            status: site.status,
            pm25: site.pm25,
            pubTime: site.pubTime,
            band: band.label,
          },
        }),
      );
      entries.push(
        createAqiOverlayEntry({
          id: site.id,
          position,
          siteName: site.siteName,
          aqi: site.aqi,
          accent: band.color,
        }),
      );
    }
    if (enabled && overlayHost) {
      overlayHost.setEntries(
        TAIWAN_AQI_OVERLAY_SOURCE_ID,
        selectAqiOverlayCohort(entries),
        { moving: false },
      );
    }
  }

  const layer = {
    id: 'taiwan-aqi',
    name: '空氣品質',
    icon: '🌫️',
    source: '環境部 · Taiwan backend',
    updateInterval: 1_800_000,

    init(nextViewer) {
      if (viewer) throw new Error('Taiwan AQI layer is already initialized');
      viewer = nextViewer;
      dataSource = new cesium.CustomDataSource('taiwan-aqi');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      console.log('[Data:TaiwanAqi] Initialized');
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost?.setVisible(TAIWAN_AQI_OVERLAY_SOURCE_ID, true);
      registerPickOwner(
        'taiwan-aqi',
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
      selectedSite = null;
      unregisterPickOwner('taiwan-aqi');
      removeClickHandler();
      overlayHost?.clearSource(TAIWAN_AQI_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible(TAIWAN_AQI_OVERLAY_SOURCE_ID, false);
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
        sites = rows;
        stale = false;
        offline = false;
        lastUpdate = Date.now();
        rebuild();
        console.log(`[Data:TaiwanAqi] Updated: ${rows.length} stations`);
        return true;
      } catch {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        // Handled steady state: keep the last good render, surface 未連線後端.
        offline = true;
        stale = sites.length > 0;
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
      if (params.clear === true || params.siteId === null) {
        select(null);
        return;
      }
      if (typeof params.siteId === 'string') {
        const site = findSite(params.siteId);
        if (site) select(site, { focus: params.focus === true });
      }
    },

    getRowControls() {
      const worst = sites
        .filter((site) => site.aqi != null)
        .sort((a, b) => b.aqi - a.aqi)
        .slice(0, 5);
      const detail = offline
        ? OFFLINE_MESSAGE
        : loading
          ? '連線中…'
          : selectedSite
            ? `${selectedSite.siteName}（${selectedSite.county || '未知縣市'}）`
            : sites.length
              ? `${sites.length} 個測站`
              : '尚無資料';
      return {
        list: worst.length
          ? {
              ariaLabel: '空氣品質測站列表（依 AQI 由高至低）',
              items: worst.map((site) => {
                const band = aqiBand(site.aqi);
                return {
                  id: site.id,
                  ordinal: worst.indexOf(site) + 1,
                  lead: site.aqi != null ? String(site.aqi) : '—',
                  text: `${site.siteName}${site.county ? ` · ${site.county}` : ''} · ${band.name}`,
                  active: Boolean(selectedSite && selectedSite.id === site.id),
                  params: { siteId: site.id, focus: true },
                };
              }),
            }
          : null,
        chips: [],
        legend: AQI_BANDS.map((band) => ({
          label: `${band.label} ${band.name}`,
          color: band.color,
        })),
        info: selectedSite
          ? `${selectedSite.siteName}（${selectedSite.county || '未知縣市'}）
AQI ${selectedSite.aqi != null ? selectedSite.aqi : '—'}${selectedSite.status ? ` · ${selectedSite.status}` : ''}
PM2.5 ${selectedSite.pm25 != null ? `${selectedSite.pm25} μg/m³` : '未知'}
資料時間 ${selectedSite.pubTime || '未知'}`
          : `${detail}\n測站顏色依 AQI 標準分級；清單列出目前最差的五個測站。`,
        infoTitle:
          '環境部空氣品質監測站（經台灣後端轉介）。點選測站或清單項目可檢視數值並飛往該位置。',
      };
    },

    setRowControlsListener(value) {
      rowControlsListener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: sites.length,
        lastUpdate,
        loading,
        stale,
        source: '環境部 · Taiwan backend',
        status: offline ? 'idle' : 'nominal',
        statusMessage: offline ? OFFLINE_MESSAGE : undefined,
        ...(selectedSite ? { selectedSite: selectedSite.siteName } : {}),
      };
    },

    getDiagnostics() {
      return {
        enabled,
        loading,
        offline,
        stale,
        count: sites.length,
        selectedSite: selectedSite?.siteName || null,
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
      sites = [];
      rowControlsListener = null;
    },
  };
  return layer;
}
