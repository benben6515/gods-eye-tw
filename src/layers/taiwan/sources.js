import {
  normalizeAqiRows,
  normalizeCctvRows,
  normalizeQuakeRows,
  normalizeTyphoon,
} from './records.js';

const DEFAULT_CCTV_LIMIT = 100;
const DEFAULT_QUAKE_LIMIT = 20;

/**
 * One source factory per fixed backend endpoint. All four share the caller's
 * client so the backoff gate is common; each normalizes independently.
 */
export function createTaiwanQuakeSource({
  client,
  limit = DEFAULT_QUAKE_LIMIT,
} = {}) {
  if (typeof client?.get !== 'function')
    throw new TypeError('Taiwan quake source requires a backend client');
  return {
    async getSnapshot({ signal, limit: rowLimit } = {}) {
      const count =
        Number.isInteger(rowLimit) && rowLimit > 0 ? rowLimit : limit;
      const rows = normalizeQuakeRows(
        await client.get(`/taiwan/quake?limit=${count}`, { signal }),
      );
      if (!rows) throw new Error('Malformed Taiwan quake snapshot');
      return rows;
    },
  };
}

export function createTaiwanCctvSource({
  client,
  city = 'Taipei',
  limit = DEFAULT_CCTV_LIMIT,
} = {}) {
  if (typeof client?.get !== 'function')
    throw new TypeError('Taiwan CCTV source requires a backend client');
  return {
    async getSnapshot({ signal, city: rowCity, limit: rowLimit } = {}) {
      const resolvedCity = String(rowCity || city).trim() || 'Taipei';
      const count =
        Number.isInteger(rowLimit) && rowLimit > 0 ? rowLimit : limit;
      const params = new URLSearchParams({ city: resolvedCity });
      if (count > 0) params.set('limit', String(count));
      const rows = normalizeCctvRows(
        await client.get(`/taiwan/cctv?${params.toString()}`, { signal }),
      );
      if (!rows) throw new Error('Malformed Taiwan CCTV snapshot');
      return rows;
    },
  };
}

/**
 * Resolves one camera's playable HLS URL through the backend. Taipei cameras
 * hide behind an on-demand transcoder whose origin serves no CORS and rotates
 * session paths — the backend hands back a same-origin proxy manifest URL
 * (relative), which this resolver absolutizes against the backend base.
 * The first open can legitimately take 10–30s, hence the 30s call timeout.
 * Returns { configured, status, url, ... } with an absolute url, or null.
 */
export function createTaiwanCctvStreamResolver({ client } = {}) {
  if (typeof client?.get !== 'function')
    throw new TypeError('Taiwan CCTV stream resolver requires a backend client');
  return {
    async resolve({ city, id, signal } = {}) {
      if (!city || !id) return null;
      const params = new URLSearchParams({ city: String(city), id: String(id) });
      let payload;
      try {
        payload = await client.get(`/taiwan/cctv/stream?${params.toString()}`, {
          signal,
          timeoutMs: 30_000,
        });
      } catch {
        return null;
      }
      if (!payload || typeof payload.status !== 'string') return null;
      if (payload.url) {
        return { ...payload, url: client.resolveUrl(payload.url) };
      }
      return payload;
    },
  };
}

export function createTaiwanTyphoonSource({ client } = {}) {
  if (typeof client?.get !== 'function')
    throw new TypeError('Taiwan typhoon source requires a backend client');
  return {
    async getSnapshot({ signal } = {}) {
      const snapshot = normalizeTyphoon(
        await client.get('/taiwan/typhoon', { signal }),
      );
      if (!snapshot) throw new Error('Malformed Taiwan typhoon snapshot');
      return snapshot;
    },
  };
}

export function createTaiwanAqiSource({ client } = {}) {
  if (typeof client?.get !== 'function')
    throw new TypeError('Taiwan AQI source requires a backend client');
  return {
    async getSnapshot({ signal } = {}) {
      const rows = normalizeAqiRows(
        await client.get('/taiwan/aqi', { signal }),
      );
      if (!rows) throw new Error('Malformed Taiwan AQI snapshot');
      return rows;
    },
  };
}
