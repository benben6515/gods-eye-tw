/**
 * Site gate — the whole app boots behind a shared password.
 *
 * main.js awaits ensureSiteGate() BEFORE application.start(), so nothing
 * expensive (Cesium tiles, ion quota, backend proxies) loads until the gate
 * opens. A valid token lives in localStorage for 7 days (matching the
 * backend-issued JWT expiry); an expired or missing token shows the overlay.
 *
 * The gate is UX + asset protection, not crypto: the backend SiteGuard is the
 * real enforcement point on every protected route.
 */

const STORAGE_KEY = 'gev-site-token';

/** Read the stored site token; null when unavailable (Node, storage blocked). */
export function readStoredToken(storage = safeStorage()) {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token, storage = safeStorage()) {
  try {
    storage.setItem(STORAGE_KEY, token);
  } catch {
    /* private mode etc. — gate will just re-ask next visit */
  }
}

function safeStorage() {
  return typeof localStorage !== 'undefined' ? localStorage : undefined;
}

/** Decode a JWT payload without verifying (verification is the backend's job). */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const json = atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** True when the token decodes to a site-scoped, unexpired JWT. */
export function isTokenUsable(token, now = Date.now()) {
  const payload = decodeJwtPayload(token);
  if (!payload || payload.scope !== 'site') return false;
  if (typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 > now;
}

/** Authorization headers for backend calls; undefined when not unlocked. */
export function siteAuthHeaders(token = readStoredToken()) {
  if (!isTokenUsable(token)) return undefined;
  return { Authorization: `Bearer ${token}` };
}

function styleEl(doc) {
  const style = doc.createElement('style');
  style.textContent = `
.gev-gate { position: fixed; inset: 0; z-index: 9999; display: flex;
  align-items: center; justify-content: center; background: rgba(2, 8, 5, 0.97); }
.gev-gate-card { width: min(360px, 88vw); border: 1px solid rgba(120, 255, 170, 0.3);
  border-radius: 8px; padding: 28px 26px; background: rgba(6, 14, 10, 0.98);
  font-family: ui-monospace, monospace; color: #d7ffe4; }
.gev-gate-title { font-size: 15px; letter-spacing: 0.2em; color: #8dffb0; margin-bottom: 6px; }
.gev-gate-sub { font-size: 11px; color: #5fae7c; margin-bottom: 18px; letter-spacing: 0.06em; }
.gev-gate-input { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.06);
  border: 1px solid rgba(120,255,170,0.3); color: #eaf6ee; font: 16px ui-monospace, monospace;
  padding: 10px 11px; border-radius: 5px; outline: none; }
  /* 16px is deliberate: iOS auto-zooms the page on focus below it (Input Zoom). */
.gev-gate-input:focus { border-color: #8dffb0; }
.gev-gate-button { margin-top: 12px; width: 100%; cursor: pointer;
  background: rgba(120,255,170,0.14); border: 1px solid rgba(120,255,170,0.4);
  color: #8dffb0; font: 600 12px ui-monospace, monospace; letter-spacing: 0.14em;
  padding: 10px; border-radius: 5px; }
.gev-gate-button:disabled { opacity: 0.5; cursor: default; }
.gev-gate-error { min-height: 16px; margin-top: 10px; font-size: 11px; color: #ff8f8f; }
.gev-gate-hint { margin-top: 14px; font-size: 10px; color: #3d7a56; text-align: center;
  letter-spacing: 0.08em; }
`;
  return style;
}

/** Render the overlay, wire submit; resolves via onUnlock once a token is stored. */
export function showGateOverlay(
  container,
  { apiBase, fetchImpl = (...args) => fetch(...args), document: documentImpl, storage, onUnlock },
) {
  const doc = documentImpl ?? container.ownerDocument;
  doc.head?.appendChild?.(styleEl(doc));

  const overlay = doc.createElement('div');
  overlay.className = 'gev-gate';
  const card = doc.createElement('div');
  card.className = 'gev-gate-card';

  const title = doc.createElement('div');
  title.className = 'gev-gate-title';
  title.textContent = "GOD'S EYE // RESTRICTED";
  const sub = doc.createElement('div');
  sub.className = 'gev-gate-sub';
  sub.textContent = '此站僅限授權人員 · clearance required';
  const input = doc.createElement('input');
  input.className = 'gev-gate-input';
  input.type = 'password';
  input.placeholder = 'access password';
  const button = doc.createElement('button');
  button.className = 'gev-gate-button';
  button.textContent = 'UNLOCK';
  const error = doc.createElement('div');
  error.className = 'gev-gate-error';
  const hint = doc.createElement('div');
  hint.className = 'gev-gate-hint';
  hint.textContent = 'Are you a good god?';

  card.appendChild(title);
  card.appendChild(sub);
  card.appendChild(input);
  card.appendChild(button);
  card.appendChild(error);
  card.appendChild(hint);
  overlay.appendChild(card);
  container.appendChild(overlay);

  const unlock = async () => {
    const password = input.value;
    if (!password) return;
    button.disabled = true;
    error.textContent = '';
    try {
      const response = await fetchImpl(`${apiBase}/auth/site-gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        error.textContent =
          response.status === 429
            ? '嘗試太多次，稍後再試。'
            : response.status === 503
              ? '閘門未設定（後端缺少 SITE_GATE_PASSWORD）。'
              : '存取碼錯誤。';
        return;
      }
      const data = await response.json().catch(() => null);
      const token = data?.token;
      if (typeof token !== 'string' || !isTokenUsable(token)) {
        error.textContent = '後端回應異常。';
        return;
      }
      storeToken(token, storage);
      overlay.remove();
      onUnlock?.();
    } catch {
      error.textContent = '無法連線後端。';
    } finally {
      button.disabled = false;
    }
  };

  button.addEventListener('click', unlock);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') unlock();
  });
  input.focus();
  return overlay;
}

/**
 * Boot gate: resolve immediately when a usable token exists; otherwise show
 * the overlay and resolve after a successful unlock. Awaits forever silently
 * when the backend base is unset (local pure-frontend dev).
 */
export function ensureSiteGate({
  apiBase,
  document: documentImpl = document,
  storage,
  fetchImpl,
  container = documentImpl?.body,
} = {}) {
  return new Promise((resolve) => {
    if (!apiBase) {
      resolve();
      return;
    }
    if (isTokenUsable(readStoredToken(storage))) {
      resolve();
      return;
    }
    showGateOverlay(container, {
      apiBase,
      document: documentImpl,
      fetchImpl,
      storage,
      onUnlock: () => resolve(),
    });
  });
}
