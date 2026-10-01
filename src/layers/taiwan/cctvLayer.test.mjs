import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaiwanCctvLayer, TAIWAN_CCTV_CITIES } from './cctvLayer.js';

function makeHarness(options = {}) {
  const log = { flyTo: [], panelOpened: [], panelClosed: 0, panelDestroyed: 0 };
  class EntityCollection {
    constructor() {
      this.values = [];
    }
    add(entity) {
      this.values.push(entity);
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
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    BoundingSphere: {
      fromPoints: (points) => ({ center: points[0], radius: 0 }),
    },
    HeightReference: { CLAMP_TO_GROUND: 2 },
    Color: {
      fromCssColorString: (css) => ({
        css,
        withAlpha: () => ({ css }),
      }),
    },
    ScreenSpaceEventHandler: FakeScreenSpaceEventHandler,
    ScreenSpaceEventType: { LEFT_CLICK: 'left' },
  };
  const camera = {
    id: 'A1-本-001',
    name: '市民大道-復興北路口',
    road: '市民大道',
    direction: '東向',
    mile: '12.5K',
    lat: 25.0439,
    lon: 121.5432,
    videoUrl: 'https://cctv.example/tw/live.m3u8',
    updatedAt: '2026-10-01T08:00:00+08:00',
  };
  const paths = [];
  const source = {
    getSnapshot: async ({ signal, city }) => {
      paths.push({ city, limit: options.limit ?? undefined });
      if (options.fail) throw new Error('ECONNREFUSED');
      return [camera];
    },
  };
  const viewer = {
    dataSources: {
      add(dataSource) {
        return dataSource;
      },
      remove() {
        return true;
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
  const panel = {
    open: (openedCamera) => log.panelOpened.push(openedCamera),
    close: () => {
      log.panelClosed += 1;
    },
    isOpen: () => log.panelOpened.length > log.panelClosed,
    destroy: () => {
      log.panelDestroyed += 1;
    },
  };
  return {
    cesium,
    viewer,
    camera,
    source,
    paths,
    log,
    options,
    clickHandlers,
    createPanel: () => panel,
  };
}

test('台灣道路攝影 loads a city, lists city chips, and opens live video on click', async () => {
  const harness = makeHarness();
  const { cesium, viewer, camera, paths, log, clickHandlers } = harness;
  const layer = createTaiwanCctvLayer({
    source: harness.source,
    cesium,
    createPanel: harness.createPanel,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer, {});
  assert.equal(paths[0].city, 'Taipei', 'the contract default city is Taipei');
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().city, 'Taipei');

  const controls = layer.getRowControls();
  assert.equal(controls.readout, undefined, 'inline row controls');
  assert.equal(controls.chips.length, TAIWAN_CCTV_CITIES.length);
  assert.equal(controls.chips.find((chip) => chip.active).id, 'city-Taipei');
  assert.match(
    controls.info,
    /交通部TDX平臺/,
    'attribution is carried in-panel',
  );

  assert.equal(clickHandlers.length, 1);
  viewer.nextPick = { id: 'taiwan-cctv:A1-本-001' };
  clickHandlers[0].click({ position: { x: 4, y: 6 } });
  assert.deepEqual(
    log.panelOpened[0].id,
    camera.id,
    'click opens the live panel',
  );
  assert.equal(log.flyTo.length, 1, 'click flies to the roadside position');

  // City chips refetch through the same fixed endpoint contract.
  await layer.refreshNow('Taichung');
  assert.equal(paths[1].city, 'Taichung');
  assert.equal(layer.getStats().city, 'Taichung');
  layer.destroy();
  assert.equal(log.panelDestroyed, 1, 'destroy releases the video panel');
});

test('台灣道路攝影 reports 未連線後端 and keeps the previous city loaded', async () => {
  const harness = makeHarness();
  const { cesium, viewer } = harness;
  const layer = createTaiwanCctvLayer({
    source: harness.source,
    cesium,
    createPanel: harness.createPanel,
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer, {});
  harness.options.fail = true;
  assert.equal(await layer.update(viewer, {}), true, 'offline is handled');
  const stats = layer.getStats();
  assert.equal(stats.status, 'idle');
  assert.match(stats.statusMessage, /未連線後端/);
  assert.equal(stats.count, 1, 'previous cameras stay on the globe');
  assert.match(layer.getRowControls().info, /未連線後端/);
  layer.destroy();
});
