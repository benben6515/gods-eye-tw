import { createActionTools } from '../voice/actionSchemas.js';
import { ACTION_DESCRIPTIONS } from '../../server/providers/openai/toolDescriptions.js';
import { readStoredToken } from './siteGate.js';

// Z.ai rejects the legacy flat tool shape (`tools[0].function can not be
// null`) — the nested form below is what it accepts.
const CHAT_TOOLS = createActionTools(ACTION_DESCRIPTIONS).map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

const siteBearer = () => readStoredToken() || 'gev-voice-console';

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

async function ttsViaFetch(fetchImpl, apiBase, text, voice) {
  const response = await fetchImpl(`${apiBase}/voice/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${siteBearer()}`,
    },
    body: JSON.stringify({ text, voice }),
  });
  if (!response.ok) throw new Error(`tts HTTP ${response.status}`);
  return response.blob();
}

/** GLM chat transport returning the raw completion data (tool_calls included). */
export function createChatClient({ fetchImpl = (...args) => fetch(...args), apiBase }) {
  return async function chat(messages) {
    return chatViaFetch(fetchImpl, apiBase, messages);
  };
}

/** TTS transport: text in, resolves when playback finishes. */
export function createSpeaker({
  fetchImpl = (...args) => fetch(...args),
  apiBase,
  audioFactory = typeof Audio !== 'undefined' ? () => new Audio() : null,
  objectUrl = (blob) => URL.createObjectURL(blob),
  voice = 'zh-TW-HsiaoChenNeural',
}) {
  return async function speak(text) {
    if (typeof audioFactory !== 'function') throw new Error('tts unavailable');
    const blob = await ttsViaFetch(fetchImpl, apiBase, text, voice);
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
}

/** Execute one map action through the runner tools.js wires at boot. */
export async function executeMapAction(name, args) {
  const runner = globalThis.__gevVoiceRunner;
  if (typeof runner !== 'function') {
    throw new Error('map runner unavailable');
  }
  return runner(name, args);
}
