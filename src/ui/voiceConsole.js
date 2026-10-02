import { createVoiceSession } from './voiceSession.js';
import { readStoredToken } from './siteGate.js';
import { createActionTools } from '../voice/actionSchemas.js';
import { ACTION_DESCRIPTIONS } from '../../server/providers/openai/toolDescriptions.js';

/**
 * DOM adapter for the Chinese voice console (C2).
 *
 * Mounts a 🎤 chip into the HUD summary bar and owns the panel: STT via the
 * Web Speech API (zh-TW), LLM via the backend chat proxy, speech out via the
 * backend /voice/tts proxy (msedge-tts). Degradations: no SpeechRecognition →
 * text input stays; TTS failure → reply text remains, `speak-failed` fires.
 *
 * The module is idempotent — mounting twice into the same container is a
 * no-op (HUD rebuilds must not stack consoles).
 */

const VOICE_LANG = 'zh-TW';
const DEFAULT_TTS_VOICE = 'zh-TW-HsiaoChenNeural';
// Site JWT when unlocked; the plain bearer remains a dev fallback — the
// backend gates chat abuse with per-IP quota, not this string.
const DEV_CHAT_BEARER = 'gev-voice-console';
const siteBearer = () => readStoredToken() || DEV_CHAT_BEARER;
const CHAT_SYSTEM_PROMPT =
  '你是「上帝之眼」台灣即時情資儀表板的語音助理，能透過工具直接控制地圖：' +
  '飛往地點、調整視角、開關圖層、查看 CCTV 攝影機、追蹤飛機等。' +
  '當使用者想移動地圖、查看資料或操作儀表板時，一律呼叫對應工具（不要用文字描述動作），' +
  '工具執行完成後只回一句繁體中文短語確認（十五個字以內，例如「帶你去看台北 101」）。' +
  '無法用工具完成的需求，用繁體中文簡短回答並引導回情資查詢。';
// Z.ai rejects the legacy flat tool shape (`tools[0].function can not be
// null`) — convert {type,name,description,parameters} to nested.
const CHAT_TOOLS = createActionTools(ACTION_DESCRIPTIONS).map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

/** True when the browser exposes a SpeechRecognition constructor. */
export function voiceRecognitionSupported(scope = globalThis) {
  return Boolean(
    scope && (scope.SpeechRecognition || scope.webkitSpeechRecognition),
  );
}

function styleEl(document) {
  const style = document.createElement('style');
  style.textContent = `
.gev-voice-root { display: inline-flex; align-items: center; gap: 6px; position: relative;
  /* The HUD overlay chain is pointer-events:none; the console opts back in. */
  pointer-events: auto; }
.gev-voice-mic { background: rgba(10, 25, 18, 0.85); border: 1px solid rgba(120, 255, 170, 0.35);
  color: #8dffb0; cursor: pointer; font: 600 11px/1 ui-monospace, monospace; letter-spacing: 0.08em;
  padding: 4px 8px; border-radius: 4px; }
.gev-voice-mic[aria-pressed="true"] { border-color: #8dffb0; color: #0a1912; background: #8dffb0; }
.gev-voice-panel { position: absolute; bottom: calc(100% + 8px); left: 0; width: min(340px, 80vw);
  max-height: 300px; overflow-y: auto; background: rgba(6, 14, 10, 0.95);
  border: 1px solid rgba(120, 255, 170, 0.3); border-radius: 6px; padding: 8px; z-index: 60; }
.gev-voice-status { color: #6fdc93; font: 500 10px/1.4 ui-monospace, monospace; letter-spacing: 0.06em;
  min-height: 14px; margin-bottom: 6px; }
.gev-voice-bubble { border-radius: 5px; padding: 5px 7px; margin: 4px 0; font: 12px/1.5 system-ui, sans-serif; }
.gev-voice-bubble.user { background: rgba(120, 255, 170, 0.12); color: #d7ffe4; }
.gev-voice-bubble.reply { background: rgba(255, 255, 255, 0.06); color: #eaf6ee; cursor: pointer; }
.gev-voice-inputrow { display: flex; gap: 4px; margin-top: 6px; }
.gev-voice-input { flex: 1; background: rgba(255,255,255,0.07); border: 1px solid rgba(120,255,170,0.25);
  color: #eaf6ee; font: 12px system-ui, sans-serif; padding: 4px 6px; border-radius: 4px; }
.gev-voice-send { background: rgba(120,255,170,0.15); border: 1px solid rgba(120,255,170,0.35);
  color: #8dffb0; cursor: pointer; border-radius: 4px; padding: 4px 8px; }
`;
  return style;
}

function el(document, className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buttonEl(document, className, label) {
  const node = document.createElement('button');
  node.className = className;
  node.type = 'button';
  node.textContent = label;
  return node;
}

/** Build a recognition instance with zh-TW tuning; null when unsupported. */
export function createRecognition(getRecognitionCtor, handlers, lang = VOICE_LANG) {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) final += result[0].transcript;
      else interim += result[0].transcript;
    }
    handlers.onInterim(interim);
    if (final) handlers.onFinal(final.trim());
  };
  if (handlers.onError) recognition.onerror = (event) => handlers.onError(event?.error);
  if (handlers.onEnd) recognition.onend = () => handlers.onEnd();
  return recognition;
}

async function chatViaFetch(fetchImpl, apiBase, messages) {
  const response = await fetchImpl(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${siteBearer()}`,
    },
    body: JSON.stringify({ messages, tools: CHAT_TOOLS, stream: false }),
  });
  if (!response.ok) throw new Error(`chat HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  if (!data) throw new Error('chat returned no JSON');
  return data;
}

/** Execute one map action through the runner tools.js wired at boot. */
async function executeMapAction(name, args) {
  const runner = globalThis.__gevVoiceRunner;
  if (typeof runner !== 'function') {
    throw new Error('map runner unavailable');
  }
  return runner(name, args);
}

async function ttsViaFetch(fetchImpl, apiBase, text, voice = DEFAULT_TTS_VOICE) {
  const response = await fetchImpl(`${apiBase}/voice/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${siteBearer()}`,
    },
    body: JSON.stringify({ text, voice }),
  });
  if (!response.ok) throw new Error(`tts HTTP ${response.status}`);
  const blob = await response.blob();
  return blob;
}

/**
 * Mount the console. Returns the session (null when already mounted).
 * All transports are injectable; defaults hit the real backend.
 */
export function mountVoiceConsole(
  container,
  {
    apiBase,
    fetchImpl = (...args) => fetch(...args),
    document: documentImpl,
    // Real browsers speak; headless tests pass null to run text-only.
    audioFactory = typeof Audio !== 'undefined' ? () => new Audio() : null,
    getRecognitionCtor = () =>
      globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null,
    objectUrl = (blob) => URL.createObjectURL(blob),
    now = () => new Date(),
  } = {},
) {
  const doc = documentImpl ?? container.ownerDocument;
  if (container.querySelector('.gev-voice-root')) return null;

  doc.head?.appendChild?.(styleEl(doc));

  const root = el(doc, 'gev-voice-root');
  const mic = buttonEl(doc, 'gev-voice-mic', '🎤 VOICE');
  mic.setAttribute('aria-pressed', 'false');
  const panel = el(doc, 'gev-voice-panel');
  panel.hidden = true;
  const status = el(doc, 'gev-voice-status', '');
  const bubbles = el(doc, 'gev-voice-bubbles');
  const inputRow = el(doc, 'gev-voice-inputrow');
  const input = doc.createElement('input');
  input.className = 'gev-voice-input';
  input.placeholder = '或用文字輸入…';
  const send = buttonEl(doc, 'gev-voice-send', '送出');
  inputRow.appendChild(input);
  inputRow.appendChild(send);
  panel.appendChild(status);
  panel.appendChild(bubbles);
  panel.appendChild(inputRow);
  root.appendChild(mic);
  root.appendChild(panel);
  container.appendChild(root);

  const canSpeak = typeof audioFactory === 'function';

  const speakReply = async (reply) => {
    if (!canSpeak) throw new Error('tts unavailable');
    const blob = await ttsViaFetch(fetchImpl, apiBase, reply);
    const audio = audioFactory(blob);
    audio.src = objectUrl(blob);
    // Handlers before play: instant-finish media must not race the binding.
    const done = new Promise((resolve) => {
      audio.onended = resolve;
      audio.onerror = resolve;
    });
    await audio.play();
    await done;
  };

  const addBubble = (className, text, { onClick = null } = {}) => {
    const bubble = el(doc, `gev-voice-bubble ${className}`, text);
    if (onClick) bubble.addEventListener('click', onClick);
    bubbles.appendChild(bubble);
    panel.scrollTop = panel.scrollHeight;
    return bubble;
  };

  const setStatus = (text) => {
    status.textContent = text || '';
  };

  let recognition = null;

  const session = createVoiceSession({
    chat: (messages) => chatViaFetch(fetchImpl, apiBase, messages),
    executeAction: executeMapAction,
    speak: speakReply,
    notify: (event) => {
      if (event.type === 'listening') {
        setStatus('● 聆聽中…');
        mic.setAttribute('aria-pressed', 'true');
      } else if (event.type === 'thinking') {
        setStatus(`「${event.transcript}」…`);
        mic.setAttribute('aria-pressed', 'false');
        addBubble('user', event.transcript);
      } else if (event.type === 'tool') {
        setStatus(`🗺 ${event.name}…`);
      } else if (event.type === 'reply') {
        addBubble('reply', event.reply, {
          onClick: () => {
            if (session.state === 'idle') speakReply(event.reply).catch(() => {});
          },
        });
        if (session.state === 'speaking') setStatus('🔊 播報中');
      } else if (event.type === 'speak-failed') {
        setStatus('（語音播報不可用）');
      } else if (event.type === 'error') {
        setStatus(`⚠ ${event.message}`);
        mic.setAttribute('aria-pressed', 'false');
      } else if (event.type === 'idle') {
        setStatus('');
        mic.setAttribute('aria-pressed', 'false');
      }
    },
  });

  const submitTranscript = (transcript) => {
    if (!transcript || session.state !== 'idle') return;
    panel.hidden = false;
    session.ask(transcript);
  };

  const stopRecognition = () => {
    try {
      recognition?.stop();
    } catch {
      /* already stopped */
    }
  };

  mic.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) {
      stopRecognition();
      session.cancel();
      return;
    }
    input.focus();
  });

  send.addEventListener('click', () => {
    const value = input.value.trim();
    input.value = '';
    submitTranscript(value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const value = input.value.trim();
      input.value = '';
      submitTranscript(value);
    }
  });
  // Typing intent is explicit — leave voice mode when the field takes focus
  // (a hung recognition in mic-less browsers would otherwise block typing).
  input.addEventListener('focus', () => {
    if (session.state === 'listening') {
      stopRecognition();
      session.stopListening();
    }
  });

  if (voiceRecognitionSupported({ SpeechRecognition: getRecognitionCtor() })) {
    recognition = createRecognition(getRecognitionCtor, {
      onInterim: (text) => {
        if (text) setStatus(`● ${text}…`);
        armSilenceWatchdog();
      },
      onFinal: (text) => submitTranscript(text),
      onError: () => session.cancel(),
      onEnd: () => {
        // SpeechRecognition auto-stops on silence; only drop back to idle if
        // nothing was recognized (a final result already moved the FSM on).
        if (session.state === 'listening') session.stopListening();
      },
    });
    // Some browsers expose SpeechRecognition but never resolve results (no
    // mic, denied permission, headless). A silent session auto-exits instead
    // of blocking typed input forever.
    let silenceTimer = null;
    const armSilenceWatchdog = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (session.state === 'listening') {
          stopRecognition();
          session.stopListening();
        }
      }, 6000);
    };
    if (recognition) {
      mic.addEventListener('click', () => {
        if (panel.hidden) return;
        if (session.state === 'idle') {
          if (session.startListening()) {
            armSilenceWatchdog();
            try {
              recognition.start();
            } catch {
              session.stopListening();
            }
          }
        } else if (session.state === 'listening') {
          stopRecognition();
        }
      });
    }
  }

  return { session, elements: { mic, panel, status, bubbles, input, send } };
}

/** HUD entry point: mount into the summary bar after the HUD builds its DOM. */
export function initVoiceConsole({
  apiBase,
  hudDocument = document,
} = {}) {
  const summaryWrap = hudDocument.querySelector('#intel-hud .hud-summary-wrap');
  if (!summaryWrap || !apiBase) return null;
  return mountVoiceConsole(summaryWrap, { apiBase });
}
