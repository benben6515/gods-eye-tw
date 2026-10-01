import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaiwanAqiSource,
  createTaiwanCctvSource,
  createTaiwanCctvStreamResolver,
  createTaiwanQuakeSource,
  createTaiwanTyphoonSource,
} from './sources.js';
import { createTaiwanApiClient } from './client.js';

function clientRecordingPaths(payload) {
  const paths = [];
  const client = createTaiwanApiClient({
    fetchImpl: async (url) => {
      paths.push(String(url).replace('http://localhost:3000', ''));
      return { ok: true, json: async () => payload };
    },
  });
  return { client, paths };
}

test('quake source requests the documented endpoint with its limit', async () => {
  const { client, paths } = clientRecordingPaths([
    { id: 'Q1', magnitude: 4.2, lat: 24, lon: 121, time: 1_791_916_800 },
  ]);
  const source = createTaiwanQuakeSource({ client });
  const rows = await source.getSnapshot();
  assert.equal(paths[0], '/taiwan/quake?limit=20');
  assert.equal(rows[0].id, 'Q1');
  const override = createTaiwanQuakeSource({ client, limit: 50 });
  await override.getSnapshot({ limit: 5 });
  assert.equal(paths[1], '/taiwan/quake?limit=5');
  client.destroy();
});

test('cctv source encodes city and limit query parameters', async () => {
  const { client, paths } = clientRecordingPaths([]);
  const source = createTaiwanCctvSource({ client });
  await source.getSnapshot();
  assert.equal(paths[0], '/taiwan/cctv?city=Taipei&limit=100');
  await source.getSnapshot({ city: 'Kaohsiung', limit: 25 });
  assert.equal(paths[1], '/taiwan/cctv?city=Kaohsiung&limit=25');
  client.destroy();
});

test('typhoon and aqi sources normalize the live { configured, data } envelope', async () => {
  const typhoon = clientRecordingPaths({
    configured: true,
    data: { active: false },
  });
  assert.deepEqual(
    await createTaiwanTyphoonSource({ client: typhoon.client }).getSnapshot(),
    { active: false },
  );
  assert.equal(typhoon.paths[0], '/taiwan/typhoon');

  const aqi = clientRecordingPaths({
    configured: true,
    data: [
      { siteName: '彰化', county: '彰化縣', aqi: 61, lat: 24.08, lon: 120.54 },
    ],
  });
  const sites = await createTaiwanAqiSource({
    client: aqi.client,
  }).getSnapshot();
  assert.equal(sites[0].id, '彰化');
  assert.equal(sites[0].aqi, 61);
  assert.equal(aqi.paths[0], '/taiwan/aqi');
});

test('a configured:false envelope flows through the cctv source as empty data', async () => {
  const cctv = clientRecordingPaths({ configured: false, data: null });
  const rows = await createTaiwanCctvSource({
    client: cctv.client,
  }).getSnapshot();
  assert.deepEqual(rows, []);
  cctv.client.destroy();
});

test('sources reject payloads that are not the documented shape', async () => {
  const quake = clientRecordingPaths({ quakes: 'nonsense' });
  await assert.rejects(
    createTaiwanQuakeSource({ client: quake.client }).getSnapshot(),
    /Malformed Taiwan quake snapshot/,
  );
  quake.client.destroy();
});

test('cctv stream resolver absolutizes the backend proxy URL and swallows failures', async () => {
  const payload = {
    configured: true,
    status: 'ready',
    url: '/taiwan/cctv/live?city=Taipei&id=001',
    expiresInSeconds: 150,
    retryAfterSeconds: null,
  };
  const { client, paths } = clientRecordingPaths(payload);
  const resolver = createTaiwanCctvStreamResolver({ client });

  const resolved = await resolver.resolve({ city: 'Taipei', id: '001' });

  assert.equal(
    paths[0],
    '/taiwan/cctv/stream?city=Taipei&id=001',
    'hits the documented stream endpoint',
  );
  assert.equal(
    resolved.url,
    'http://localhost:3000/taiwan/cctv/live?city=Taipei&id=001',
    'relative proxy manifest becomes absolute against the backend base',
  );
  assert.equal(resolved.status, 'ready');

  const failing = createTaiwanCctvStreamResolver({
    client: createTaiwanApiClient({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
  });
  assert.equal(await failing.resolve({ city: 'Taipei', id: '002' }), null);
});
