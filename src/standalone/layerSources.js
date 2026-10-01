import { createOpenFreeMapSource } from '../sources/openFreeMap.js';
import {
  createOpenSkySource,
  createAdsbLolSource,
  createAisStreamSource,
} from '../sources/live/standalone.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTransitSource } from '../layers/transit/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createAlprTileSource } from '../layers/alpr/source.js';
import { createWeatherSource } from '../layers/weather/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createWindSource } from '../layers/wind/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import {
  createTaiwanAqiSource,
  createTaiwanCctvSource,
  createTaiwanCctvStreamResolver,
  createTaiwanQuakeSource,
  createTaiwanTyphoonSource,
  createTaiwanApiClient,
} from '../layers/taiwan/index.js';
import { createReferenceSources } from '../sources/reference.js';
export { createReferenceSources as createStandaloneReferenceSources } from '../sources/reference.js';

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources() {
  const mapTiles = createOpenFreeMapSource();
  // One shared Taiwan backend client: a dead service backs off once for the
  // whole 台灣 family instead of once per layer tick.
  const taiwan = createTaiwanApiClient();
  return {
    ...createReferenceSources(),
    flights: createOpenSkySource(),
    military: createAdsbLolSource(),
    vessels: createAisStreamSource({
      apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/ais-live',
    }),
    cctv: createCctvSource(),
    radio: createRadioSource(),
    traffic: createTrafficSource({ mapTiles }),
    transit: createTransitSource(),
    bikeshare: createBikeshareSource(),
    installations: createInstallationSource({ mapTiles }),
    satellites: createSatelliteSource(),
    launches: createLaunchSource(),
    alpr: createAlprTileSource(),
    firms: createFirmsSource(),
    wind: createWindSource(),
    weather: createWeatherSource(),
    cyclones: createCycloneSource(),
    'taiwan-quake': createTaiwanQuakeSource({ client: taiwan }),
    'taiwan-cctv': createTaiwanCctvSource({ client: taiwan }),
    'taiwan-cctv-stream': createTaiwanCctvStreamResolver({ client: taiwan }),
    'taiwan-typhoon': createTaiwanTyphoonSource({ client: taiwan }),
    'taiwan-aqi': createTaiwanAqiSource({ client: taiwan }),
  };
}
