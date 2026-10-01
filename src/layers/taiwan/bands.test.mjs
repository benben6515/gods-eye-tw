import test from 'node:test';
import assert from 'node:assert/strict';
import { aqiBand, AQI_BANDS } from './bands.js';

test('AQI bands follow the standard 綠/黃/橘/紅/紫 edges', () => {
  const expectations = [
    [0, 'good'],
    [50, 'good'],
    [51, 'moderate'],
    [100, 'moderate'],
    [101, 'sensitive'],
    [150, 'sensitive'],
    [151, 'unhealthy'],
    [200, 'unhealthy'],
    [201, 'very-unhealthy'],
    [300, 'very-unhealthy'],
    [301, 'hazardous'],
    [500, 'hazardous'],
  ];
  for (const [aqi, key] of expectations) {
    assert.equal(aqiBand(aqi).key, key, `AQI ${aqi} → ${key}`);
  }
});

test('missing readings fall back to a defined band and every band is presentable', () => {
  const fallback = aqiBand(null);
  assert.equal(fallback.key, 'good');
  assert.equal(aqiBand(undefined).label, '綠');
  const labels = new Set(AQI_BANDS.map((band) => band.label));
  for (const label of ['綠', '黃', '橘', '紅', '紫']) {
    assert.ok(labels.has(label), `band label ${label} exists`);
  }
  for (const band of AQI_BANDS) {
    assert.match(band.color, /^#[0-9a-f]{6}$/i);
    assert.ok(band.name.length > 0);
  }
});
