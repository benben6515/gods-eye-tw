import {
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

// Runtime (not build-time) base of the personal API backend. The HUD summary
// used to call the OpenAI upstream directly, which needed an OPENAI_API_KEY
// and was the source of endless 429 noise; the backend now brokers GLM
// quota-free. Read LAZILY per request, never at module load: .env values are
// applied to process.env after this module is imported (see rate-limit.js).
function hudBackendBase() {
  return String(process.env.TAIWAN_API_BASE || '')
    .trim()
    .replace(/\/+$/, '');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // No backend configured → deliberate capability response; the HUD keeps its
  // deterministic local summary line. (Shape identical to the old keyless path.)
  const backendBase = hudBackendBase();
  if (!backendBase) {
    const keyless = keylessHudSummaryResponse(null);
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). The backend has its
  // own cache + sliding window; this remains a second door in front of it.
  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const upstream = await fetch(`${backendBase}/voice/summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Server-to-server shared secret — /voice/summary no longer accepts
        // anonymous browser traffic (SiteGuard accepts this or a site JWT).
        Authorization: `Bearer ${process.env.API_SHARED_SECRET || 'unconfigured'}`,
      },
      body: JSON.stringify({ context: JSON.stringify(context) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await upstream.json().catch(() => ({}));
    const summary = upstream.ok ? toFiveWordHudSummary(data?.summary) : '';
    res.statusCode = upstream.ok && summary ? 200 : upstream.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.ok)
      console.warn(`[hud-summary] backend HTTP ${upstream.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        error: upstream.ok ? null : 'HUD summary request failed',
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary };
