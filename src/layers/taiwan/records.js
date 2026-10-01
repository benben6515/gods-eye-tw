/**
 * Validation for the fixed Taiwan backend contract (Phase 2). Every
 * normalizer tolerates missing or malformed members — invalid rows are
 * skipped, never fatal — and returns null only when the payload is not the
 * documented shape at all. Values are JSON-safe plain data.
 */

const MAX_TEXT_LENGTH = 200;
const MAX_ROWS = 500;

const text = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return raw.length > MAX_TEXT_LENGTH ? raw.slice(0, MAX_TEXT_LENGTH) : raw;
};

const finite = (value) => (Number.isFinite(value) ? value : null);

const numberFrom = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const coordinate = (value, limit) => {
  const numeric = numberFrom(value);
  return numeric !== null && Math.abs(numeric) <= limit ? numeric : null;
};

/** Time as epoch ms; ISO strings and epoch seconds are accepted. */
const timeMs = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
};

function takeRows(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  // A configured:false envelope is a valid empty answer, not a fault.
  if (payload.configured === false) return [];
  // The backend wraps every list in a uniform { configured, data } envelope;
  // the per-feed keys stay accepted for tolerance with other shapes.
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload[key])) return payload[key];
  return null;
}

/**
 * GET /taiwan/cctv → [{ id, name, road, direction, mile, lat, lon, videoUrl, updatedAt }]
 */
export function normalizeCctvRows(payload) {
  const rows = takeRows(payload, 'cameras');
  if (!rows) return null;
  const out = [];
  const ids = new Set();
  for (const row of rows.slice(0, MAX_ROWS)) {
    const lat = coordinate(row?.lat, 90);
    const lon = coordinate(row?.lon, 180);
    const id = text(row?.id);
    if (lat === null || lon === null || !id || ids.has(id)) continue;
    ids.add(id);
    out.push({
      id,
      name: text(row?.name) || id,
      road: text(row?.road),
      direction: text(row?.direction),
      mile: text(row?.mile),
      lat,
      lon,
      videoUrl: text(row?.videoUrl),
      updatedAt: text(row?.updatedAt),
    });
  }
  return out;
}

/**
 * GET /taiwan/quake → [{ id, time, magnitude, depthKm, lat, lon, location, maxIntensity, reportUrl, imageUrl }]
 */
export function normalizeQuakeRows(payload) {
  const rows = takeRows(payload, 'quakes');
  if (!rows) return null;
  const out = [];
  const ids = new Set();
  for (const row of rows.slice(0, MAX_ROWS)) {
    const lat = coordinate(row?.lat, 90);
    const lon = coordinate(row?.lon, 180);
    const id = text(row?.id);
    if (lat === null || lon === null || !id || ids.has(id)) continue;
    const magnitude = numberFrom(row?.magnitude);
    if (magnitude === null || magnitude < 0 || magnitude > 10) continue;
    ids.add(id);
    out.push({
      id,
      time: timeMs(row?.time),
      magnitude,
      depthKm: finite(numberFrom(row?.depthKm)),
      lat,
      lon,
      location: text(row?.location),
      maxIntensity: text(row?.maxIntensity),
      reportUrl: text(row?.reportUrl),
      imageUrl: text(row?.imageUrl),
    });
  }
  return out;
}

/**
 * GET /taiwan/typhoon → { active: false } | { active: true, name, issuetime, track: [...] }
 * Accepts the backend's uniform { configured, data } envelope; configured:false
 * is "no active warning", not a fault. Returns null when the payload is not a
 * typhoon object at all.
 */
export function normalizeTyphoon(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (payload.configured === false) return { active: false };
  if (
    payload.active === undefined &&
    payload.data &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data)
  ) {
    return normalizeTyphoon(payload.data);
  }
  if (payload.active !== true) return { active: false };
  const trackRows = Array.isArray(payload.track) ? payload.track : [];
  const track = [];
  for (const row of trackRows.slice(0, MAX_ROWS)) {
    const lat = coordinate(row?.lat, 90);
    const lon = coordinate(row?.lon, 180);
    if (lat === null || lon === null) continue;
    track.push({
      time: text(row?.time),
      lat,
      lon,
      pressure: finite(numberFrom(row?.pressure)),
      maxWind: finite(numberFrom(row?.maxWind)),
    });
  }
  return {
    active: true,
    name: text(payload.name) || '颱風',
    issuetime: text(payload.issuetime),
    track,
  };
}

/**
 * GET /taiwan/aqi → [{ siteName, county, aqi, status, pm25, lat, lon, pubTime }]
 */
export function normalizeAqiRows(payload) {
  const rows = takeRows(payload, 'sites');
  if (!rows) return null;
  const out = [];
  const seen = new Map();
  for (const row of rows.slice(0, MAX_ROWS)) {
    const lat = coordinate(row?.lat, 90);
    const lon = coordinate(row?.lon, 180);
    const siteName = text(row?.siteName);
    if (lat === null || lon === null || !siteName) continue;
    const aqi = numberFrom(row?.aqi);
    // Station name is the stable identity; a repeated name is an update.
    const site = {
      id: siteName,
      siteName,
      county: text(row?.county),
      aqi: aqi !== null && aqi >= 0 ? Math.round(aqi) : null,
      status: text(row?.status),
      pm25: finite(numberFrom(row?.pm25)),
      lat,
      lon,
      pubTime: text(row?.pubTime),
    };
    const prior = seen.get(siteName);
    if (prior) out[out.indexOf(prior)] = site;
    else out.push(site);
    seen.set(siteName, site);
  }
  return out;
}
