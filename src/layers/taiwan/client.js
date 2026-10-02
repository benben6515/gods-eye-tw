/**
 * Shared HTTP client for the Taiwan backend (a NestJS service brokered
 * separately from this app's own dev server). One instance is shared by all
 * four Taiwan sources so a dead backend backs off once, not once per layer.
 *
 * Failure policy (Phase 2 contract): tolerate empty, missing or unreachable
 * endpoints gracefully. The client never logs — layers surface the
 * 未連線後端 state through their stats — and it fails fast while a backoff
 * window is open so periodic layer ticks cannot hammer an offline service.
 */
import { siteAuthHeaders } from '../../ui/siteGate.js';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** Read the configured backend origin without trusting its shape. */
export function taiwanApiBase(env = import.meta.env) {
  const raw = String(env?.VITE_TAIWAN_API_BASE || '').trim();
  try {
    const url = new URL(raw || DEFAULT_BASE_URL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return DEFAULT_BASE_URL;
    }
    return (
      url.origin +
      (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''))
    );
  } catch {
    return DEFAULT_BASE_URL;
  }
}

/** A failure that has already been accounted for by the backoff gate. */
export class TaiwanBackendUnavailableError extends Error {
  constructor(message, { retryAt = 0, cause = null } = {}) {
    super(message);
    this.name = 'TaiwanBackendUnavailableError';
    this.retryAt = retryAt;
    this.cause = cause ?? undefined;
  }
}

/**
 * Construct one client. Dependencies are injectable for deterministic tests.
 * @param {object} [options]
 * @param {string} [options.base] Backend origin; defaults to VITE_TAIWAN_API_BASE.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createTaiwanApiClient({
  base = taiwanApiBase(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  let failures = 0;
  let retryAt = 0;
  let lastError = null;
  let lastSuccessAt = null;
  let gateTimer = null;

  const openGate = () => {
    failures += 1;
    const waitMs = Math.min(
      BACKOFF_BASE_MS * 2 ** (failures - 1),
      BACKOFF_MAX_MS,
    );
    retryAt = now() + waitMs;
    if (gateTimer) clearTimer(gateTimer);
    gateTimer = setTimer(() => {
      gateTimer = null;
    }, waitMs);
  };

  const clearGate = () => {
    failures = 0;
    retryAt = 0;
    lastError = null;
    lastSuccessAt = now();
    if (gateTimer) {
      clearTimer(gateTimer);
      gateTimer = null;
    }
  };

  /** GET one JSON endpoint, gated by the shared backoff window. */
  async function get(path, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    signal?.throwIfAborted();
    if (gateTimer) {
      throw new TaiwanBackendUnavailableError('未連線後端', { retryAt });
    }
    const deadline = new AbortController();
    let timeoutHandle = null;
    let timedOut = false;
    const onExternalAbort = () => deadline.abort(signal.reason);
    if (signal) {
      if (signal.aborted) {
        deadline.abort(signal.reason);
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    timeoutHandle = setTimer(() => {
      timedOut = true;
      deadline.abort(new Error('Taiwan backend request timeout'));
    }, timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        cache: 'no-store',
        signal: deadline.signal,
        headers: siteAuthHeaders(),
      });
      if (!response.ok)
        throw new Error(`Taiwan backend HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      clearGate();
      return payload;
    } catch (error) {
      signal?.throwIfAborted();
      lastError = timedOut
        ? 'Taiwan backend request timeout'
        : error?.message || String(error);
      openGate();
      throw new TaiwanBackendUnavailableError('未連線後端', {
        retryAt,
        cause: error,
      });
    } finally {
      if (timeoutHandle !== null) clearTimer(timeoutHandle);
      signal?.removeEventListener?.('abort', onExternalAbort);
    }
  }

  return {
    get,
    /** Resolve a backend-relative path against this client's base origin. */
    resolveUrl(path) {
      try {
        return new URL(path, base).toString();
      } catch {
        return path;
      }
    },
    /** One-line liveness snapshot for layer stats. */
    getState() {
      return {
        reachable: failures === 0,
        retryAt,
        failures,
        lastError,
        lastSuccessAt,
      };
    },
    destroy() {
      if (gateTimer) {
        clearTimer(gateTimer);
        gateTimer = null;
      }
    },
  };
}
