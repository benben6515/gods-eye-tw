/**
 * 台灣 layer family — CWA earthquakes, TDX roadside CCTV, typhoon tracks and
 * EPA air quality, all acquired through the shared Taiwan backend client
 * (VITE_TAIWAN_API_BASE, default http://localhost:3000).
 */
export { createTaiwanApiClient, taiwanApiBase } from './client.js';
export {
  normalizeAqiRows,
  normalizeCctvRows,
  normalizeQuakeRows,
  normalizeTyphoon,
} from './records.js';
export {
  createTaiwanAqiSource,
  createTaiwanCctvSource,
  createTaiwanQuakeSource,
  createTaiwanTyphoonSource,
} from './sources.js';
export { aqiBand, AQI_BANDS } from './bands.js';
export { createTaiwanQuakeLayer } from './quakeLayer.js';
export { createTaiwanCctvLayer, TAIWAN_CCTV_CITIES } from './cctvLayer.js';
export { createTaiwanTyphoonLayer } from './typhoonLayer.js';
export { createTaiwanAqiLayer } from './aqiLayer.js';
export { attachTaiwanVideo, createTaiwanCctvVideoPanel } from './videoPanel.js';
