import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaiwanQuakeLayer } from './quakeLayer.js';
import { createTaiwanTyphoonLayer } from './typhoonLayer.js';
import { createTaiwanAqiLayer } from './aqiLayer.js';
import { claimPointer, releasePointer } from '../../data/inputOwnership.js';
import { pickEntityId } from './picking.js';

/** Minimal Cesium seam + viewer harness shared by the Taiwan layer tests. */
function makeHarness() {
  const log = {
    flyTo: [],
    entitiesAdded: 0,
    overlayEntries: null,
    overlayVisible: null,
  };
  class EntityCollection {
    constructor() {
      this.values = [];
    }
    add(entity) {
      this.values.push(entity);
      log.entitiesAdded += 1;
      return entity;
    }
    removeAll() {
      this.values = [];
    }
  }
  class FakeDataSource {
    constructor(name) {
      this.name = name;
      this.entities = new EntityCollection();
      this.show = false;
    }
  }
  const clickHandlers = [];
  class FakeScreenSpaceEventHandler {
    constructor() {
      clickHandlers.push(this);
      this.destroyed = false;
    }
    setInputAction(callback) {
      this.click = callback;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const cesium = {
    CustomDataSource: FakeDataSource,
    Entity: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    Cartesian3: {
      fromDegrees: (lon, lat) => ({ lon, lat }),
    },
    BoundingSphere: {
      fromPoints: (points) => ({ center: points[0], radius: 0 }),
    },
    ColorMaterialProperty: class {
      constructor(color) {
        this.color = color;
      }
    },
    PolylineDashMaterialProperty: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    HeightReference: { CLAMP_TO_GROUND: 2 },
    Color: {
      fromCssColorString: (css) => ({
        css,
        withAlpha: () => ({ css, alpha: 1 }),
        toCssColorString: () => css,
      }),
      WHITE: { withAlpha: () => ({ css: '#fff' }) },
    },
    ScreenSpaceEventHandler: FakeScreenSpaceEventHandler,
    ScreenSpaceEventType: { LEFT_CLICK: 'left' },
  };
  const viewer = {
    dataSources: {
      add(dataSource) {
        return dataSource;
      },
      remove(dataSource) {
        return dataSource !== null;
      },
    },
    scene: {
      canvas: new EventTarget(),
      pick() {
        return viewer.nextPick ?? null;
      },
    },
    camera: {
      flyToBoundingSphere(sphere, options) {
        log.flyTo.push({ sphere, options });
      },
    },
    container: {},
    isDestroyed: () => false,
  };
  const overlayHost = {
    setEntries(sourceId, entries) {
      log.overlayEntries = { sourceId, entries };
    },
    setVisible(sourceId, visible) {
      log.overlayVisible = { sourceId, visible };
    },
    clearSource(sourceId) {
      log.overlayEntries = { sourceId, entries: [] };
    },
  };
  return { cesium, viewer, overlayHost, log, clickHandlers };
}

const quakeRow = {
  id: 'Q1',
  time: 1_791_916_800_000,
  magnitude: 5.2,
  depthKm: 24.8,
  lat: 23.98,
  lon: 121.61,
  location: '花蓮縣政府東方 35.2 公里',
  maxIntensity: '4級',
  reportUrl: 'https://www.cwa.gov.tw/report',
  imageUrl: null,
};

test('台灣地震 renders on the earthquake path and flies to a clicked event', async () => {
  const { cesium, viewer, overlayHost, log, clickHandlers } = makeHarness();
  const layer = createTaiwanQuakeLayer({
    source: { getSnapshot: async () => [quakeRow] },
    overlayHost,
    cesium,
  });
  layer.init(viewer);
  let notices = 0;
  layer.setRowControlsListener(() => notices++);
  layer.enable();
  assert.equal(await layer.update(viewer, {}), true);
  assert.equal(layer.getStats().count, 1);
  assert.equal(log.overlayEntries.sourceId, 'taiwan-quake');
  assert.equal(log.overlayEntries.entries[0].title, 'M5.2');

  const controls = layer.getRowControls();
  assert.equal(
    controls.readout,
    undefined,
    'inline row controls, not a readout card',
  );
  assert.equal(controls.list.items[0].id, 'Q1');
  assert.match(controls.list.items[0].text, /花蓮縣政府東方/);
  assert.ok(notices > 0);

  assert.equal(clickHandlers.length, 1, 'enable installs exactly one handler');
  // A claimed pointer (an active draw tool, say) must suppress the selection.
  viewer.nextPick = { id: 'taiwan-quake:Q1' };
  const owner = claimPointer('test');
  try {
    clickHandlers[0].click({ position: { x: 1, y: 2 } });
    assert.equal(
      log.flyTo.length,
      0,
      'claimed pointer is checked before picking',
    );
  } finally {
    releasePointer(owner);
  }
  clickHandlers[0].click({ position: { x: 1, y: 2 } });
  assert.equal(log.flyTo.length, 1, 'click flies to the selected quake');
  const focusControls = layer.getRowControls();
  assert.match(focusControls.info, /M5\.2/);
  assert.match(focusControls.info, /最大震度 4級/);
  assert.equal(focusControls.list.items[0].active, true);
  assert.equal(focusControls.chips[0].label, '地震報告 ↗');
  let opened = null;
  const withLink = createTaiwanQuakeLayer({
    source: { getSnapshot: async () => [quakeRow] },
    overlayHost,
    cesium,
    openLink: (url) => {
      opened = url;
    },
  });
  withLink.init(viewer);
  withLink.enable();
  await withLink.update(viewer, {});
  withLink.setParams({ quakeId: 'Q1' });
  withLink.setParams({ report: true });
  assert.equal(opened, quakeRow.reportUrl);
  withLink.destroy();
  layer.destroy();
});

test('台灣地震 keeps the last good render and reports 未連線後端 while offline', async () => {
  const { cesium, viewer, overlayHost } = makeHarness();
  let fail = false;
  const layer = createTaiwanQuakeLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('ECONNREFUSED');
        return [quakeRow];
      },
    },
    overlayHost,
    cesium,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer, {});
  fail = true;
  assert.equal(
    await layer.update(viewer, {}),
    true,
    'offline is a handled state',
  );
  const stats = layer.getStats();
  assert.equal(stats.status, 'idle');
  assert.match(stats.statusMessage, /未連線後端/);
  assert.equal(stats.count, 1, 'previous events stay rendered');
  assert.equal(stats.stale, true);
  const controls = layer.getRowControls();
  assert.match(controls.info, /最近 1 則顯著地震/);
  layer.destroy();
});

test('颱風路徑 stays quiet when no warning is active and draws an active track', async () => {
  const { cesium, viewer, overlayHost, log } = makeHarness();
  let snapshot = { active: false };
  const layer = createTaiwanTyphoonLayer({
    source: { getSnapshot: async () => snapshot },
    overlayHost,
    cesium,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer, {});
  assert.match(layer.getRowControls().info, /目前無颱風警報/);
  assert.equal(
    log.overlayEntries.entries.length,
    0,
    'inactive keeps the globe clear',
  );

  snapshot = {
    active: true,
    name: '樺加沙',
    issuetime: '2026-10-01 05:30',
    track: [
      { time: '10-01 05Z', lat: 21.5, lon: 124.8, pressure: 940, maxWind: 45 },
      { time: '10-01 08Z', lat: 22.4, lon: 123.9, pressure: 950, maxWind: 40 },
    ],
  };
  await layer.update(viewer, {});
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  const controls = layer.getRowControls();
  assert.match(controls.info, /樺加沙/);
  assert.match(controls.info, /22\.4°N/);
  assert.equal(
    controls.chips[0].params.focus,
    true,
    'focus chip flies to the center',
  );
  assert.equal(controls.legend.length, 2, 'track and center legend entries');
  layer.setParams({ focus: true });
  assert.equal(log.flyTo.length, 1, 'focus action flies to the current center');
  assert.equal(log.overlayEntries.entries[0].title, '樺加沙');
  layer.destroy();
});

test('空氣品質 colors stations by band and surfaces the selected station', async () => {
  const { cesium, viewer, overlayHost, log, clickHandlers } = makeHarness();
  const layer = createTaiwanAqiLayer({
    source: {
      getSnapshot: async () => [
        {
          id: '善化',
          siteName: '善化',
          county: '臺南市',
          aqi: 42,
          status: '良好',
          pm25: 8.1,
          lat: 23.11,
          lon: 120.28,
          pubTime: '2026-10-01 08:00',
        },
        {
          id: '前金',
          siteName: '前金',
          county: '高雄市',
          aqi: 162,
          status: '不健康',
          pm25: 30,
          lat: 22.62,
          lon: 120.3,
          pubTime: '2026-10-01 08:00',
        },
      ],
    },
    overlayHost,
    cesium,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer, {});
  const controls = layer.getRowControls();
  assert.equal(
    controls.legend.map((entry) => entry.label[0]).join(''),
    '綠黃橘紅紫褐',
  );
  assert.equal(log.overlayEntries.entries.length, 2);
  const worst = log.overlayEntries.entries[0];
  assert.equal(worst.title, '前金 162', 'worst station wins label priority');
  assert.equal(worst.accent, '#e53935');

  viewer.nextPick = { id: 'taiwan-aqi:前金' };
  clickHandlers[0].click({ position: { x: 1, y: 2 } });
  assert.equal(log.flyTo.length, 1);
  const selected = layer.getRowControls();
  assert.match(selected.info, /前金/);
  assert.match(selected.info, /AQI 162/);
  assert.match(selected.info, /PM2\.5 30/);
  assert.equal(
    selected.list.items[0].id,
    '前金',
    'worst station leads the list',
  );
  layer.destroy();
});

test('pickEntityId resolves both entity-object and primitive pick shapes', () => {
  const prefix = 'taiwan-quake:';
  const entity = (id) => ({ id });
  assert.equal(pickEntityId({ id: entity(`${prefix}Q1`) }, prefix), 'Q1');
  assert.equal(
    pickEntityId({ primitive: { id: `${prefix}Q2` } }, prefix),
    'Q2',
  );
  assert.equal(pickEntityId({ id: `${prefix}Q3` }, prefix), 'Q3');
  assert.equal(pickEntityId({ id: entity('flights:abc') }, prefix), null);
  assert.equal(pickEntityId({}, prefix), null);
  assert.equal(pickEntityId(null, prefix), null);
});

test('every Taiwan layer reports the 未連線後端 guidance without throwing', async () => {
  const { cesium, viewer, overlayHost } = makeHarness();
  const failing = {
    getSnapshot: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
  for (const create of [
    () => createTaiwanQuakeLayer({ source: failing, overlayHost, cesium }),
    () => createTaiwanTyphoonLayer({ source: failing, overlayHost, cesium }),
    () => createTaiwanAqiLayer({ source: failing, overlayHost, cesium }),
  ]) {
    const layer = create();
    layer.init(viewer);
    layer.enable();
    assert.equal(await layer.update(viewer, {}), true);
    assert.equal(layer.getStats().status, 'idle');
    assert.match(layer.getStats().statusMessage, /未連線後端/);
    layer.destroy();
  }
});
