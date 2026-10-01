import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAqiRows,
  normalizeCctvRows,
  normalizeQuakeRows,
  normalizeTyphoon,
} from './records.js';

const cctvRow = {
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

const quakeRow = {
  id: 'EQ20261001080123',
  time: '2026-10-01T00:01:23+08:00',
  magnitude: 5.2,
  depthKm: 24.8,
  lat: 23.98,
  lon: 121.61,
  location: '花蓮縣政府東方 35.2 公里',
  maxIntensity: '4級',
  reportUrl: 'https://www.cwa.gov.tw/V8/C/EQ/REPORT/202610.html',
  imageUrl: 'https://www.cwa.gov.tw/intensity.png',
};

const aqiRow = {
  siteName: '屏東(枋山)',
  county: '屏東縣',
  aqi: '82.4',
  status: '普通',
  pm25: '12.5',
  lat: '22.4206',
  lon: '120.6519',
  pubTime: '2026-10-01 08:00',
};

test('CCTV normalization keeps valid cameras and skips malformed rows', () => {
  const rows = normalizeCctvRows([
    cctvRow,
    { ...cctvRow, id: 'A2', lat: 'x' },
    { ...cctvRow, id: 'A3', lon: 999 },
    { id: '', lat: 1, lon: 2 },
    null,
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'A1-本-001');
  assert.equal(rows[0].lat, 25.0439);
  assert.equal(rows[0].videoUrl, 'https://cctv.example/tw/live.m3u8');
});

test('CCTV normalization accepts bare arrays and the configured envelope, rejects other shapes', () => {
  assert.deepEqual(normalizeCctvRows([cctvRow])[0].id, 'A1-本-001');
  // The live backend wraps every list in { configured, data }.
  assert.deepEqual(
    normalizeCctvRows({ configured: true, data: [cctvRow] })[0].id,
    'A1-本-001',
  );
  assert.equal(normalizeCctvRows({ cameras: 'nope' }), null);
  assert.equal(normalizeCctvRows({}), null);
  assert.equal(normalizeCctvRows(null), null);
});

test('configured:false envelopes are empty data, never a disconnect', () => {
  assert.deepEqual(normalizeCctvRows({ configured: false, data: null }), []);
  assert.deepEqual(normalizeQuakeRows({ configured: false }), []);
  assert.deepEqual(normalizeAqiRows({ configured: false, data: [] }), []);
});

test('legacy per-feed keys stay tolerated beside the generic envelope', () => {
  assert.deepEqual(
    normalizeCctvRows({ cameras: [cctvRow] })[0].id,
    'A1-本-001',
  );
  assert.deepEqual(
    normalizeQuakeRows({ quakes: [quakeRow] })[0].id,
    'EQ20261001080123',
  );
  assert.deepEqual(normalizeAqiRows({ sites: [aqiRow] })[0].id, '屏東(枋山)');
});

test('quake normalization validates magnitude and position bounds', () => {
  const rows = normalizeQuakeRows({
    configured: true,
    data: [
      quakeRow,
      { ...quakeRow, id: 'B', magnitude: 11 },
      { ...quakeRow, id: 'C', magnitude: -1 },
      { ...quakeRow, id: 'D', lat: 95 },
      { ...quakeRow, id: 'E', magnitude: '4.1' },
      { ...quakeRow, id: 'F', time: 1_791_916_800 },
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['EQ20261001080123', 'E', 'F'],
  );
  assert.equal(rows[1].magnitude, 4.1);
  // Epoch seconds are promoted to milliseconds.
  assert.equal(rows[2].time, 1_791_916_800_000);
});

test('typhoon normalization passes the inactive marker through untouched', () => {
  assert.deepEqual(normalizeTyphoon({ active: false }), { active: false });
  assert.deepEqual(normalizeTyphoon({}), { active: false });
  // The envelope forms: configured:false and wrapped payloads are both quiet.
  assert.deepEqual(normalizeTyphoon({ configured: false }), { active: false });
  assert.deepEqual(normalizeTyphoon({ configured: true, data: null }), {
    active: false,
  });
  assert.deepEqual(
    normalizeTyphoon({ configured: true, data: { active: false } }),
    { active: false },
  );
  assert.equal(normalizeTyphoon(null), null);
  assert.equal(normalizeTyphoon('storm'), null);
});

test('typhoon normalization validates track points and coerces numbers', () => {
  const storm = normalizeTyphoon({
    configured: true,
    data: {
      active: true,
      name: '樺加沙',
      issuetime: '2026-10-01 05:30',
      track: [
        {
          time: '10-01 05Z',
          lat: 21.5,
          lon: 124.8,
          pressure: '940',
          maxWind: 45,
        },
        {
          time: '10-01 08Z',
          lat: null,
          lon: 125.2,
          pressure: 945,
          maxWind: 43,
        },
        {
          time: '10-01 11Z',
          lat: 22.8,
          lon: '121.0',
          pressure: 958,
          maxWind: 38,
        },
      ],
    },
  });
  assert.equal(storm.active, true);
  assert.equal(storm.name, '樺加沙');
  assert.equal(storm.track.length, 2);
  assert.equal(storm.track[0].pressure, 940);
  assert.equal(storm.track[1].lon, 121.0);
});

test('AQI normalization derives station identity and rounds the index', () => {
  const rows = normalizeAqiRows({
    configured: true,
    data: [aqiRow, { ...aqiRow, aqi: 90, pm25: null }],
  });
  assert.equal(rows.length, 1, 'station name is the stable identity');
  assert.equal(rows[0].id, '屏東(枋山)');
  assert.equal(rows[0].aqi, 90, 'repeated rows are updates, later wins');
  assert.equal(rows[0].pm25, null);
  assert.equal(rows[0].lat, 22.4206);
});
