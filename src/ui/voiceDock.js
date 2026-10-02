import { createVoiceControl } from '../voice/control.js';
import { createVoiceSession } from './voiceSession.js';
import {
  createChatClient,
  createSpeaker,
  executeMapAction,
} from './voiceTransports.js';

/**
 * The dock voice UI (the original God's Eye mic) reborn on the self-hosted
 * stack: same look — AI AGENT heading, mic button, visualizer, readout —
 * but the brain is GLM via /chat/completions (function calling drives the
 * map) and the voice is edge-tts. No OpenAI anywhere.
 *
 * Interaction: click toggles a listen loop. Each recognized sentence is sent,
 * executed (map actions run for real), and the spoken confirmation plays;
 * afterwards the mic re-arms automatically until toggled off. During
 * thinking/speaking the mic is paused so the TTS output never feeds back in.
 */

/** Map a session event to the dock's dataset.status / label / readout text. */
export function mapEventToDock(event) {
  switch (event?.type) {
    case 'listening':
      return { status: 'listening', label: 'LISTENING', detail: '聆聽中…說完自動執行' };
    case 'thinking':
      return { status: 'executing', label: 'EXECUTING', detail: '思考中…' };
    case 'tool':
      return { status: 'executing', label: 'EXECUTING', detail: `執行 ${event.name}…` };
    case 'reply':
      return { status: 'executing', label: 'SPEAKING', detail: event.reply };
    case 'speak-failed':
      return { status: 'idle', label: 'OFF', detail: '（語音播報不可用）' };
    case 'error':
      return { status: 'error', label: 'ERROR', detail: event.message || '語音系統錯誤' };
    case 'idle':
      return { status: 'idle', label: 'OFF', detail: 'VOICE STANDBY' };
    default:
      return null;
  }
}

/**
 * Mount the dock voice. Safe to call once per boot (tools.js). Returns the
 * session, or null when SpeechRecognition is unavailable — then the HUD chip
 * console (text input) remains the only entrypoint.
 */
export function mountVoiceDock({
  apiBase,
  runner = null,
  fetchImpl = (...args) => fetch(...args),
  audioFactory = typeof Audio !== 'undefined' ? () => new Audio() : null,
  getRecognitionCtor = () =>
    globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null,
  document: documentImpl = document,
} = {}) {
  const ui = createVoiceControl();
  ui.tierButton.hidden = true; // no tiers on the free self-hosted stack
  ui.costValue.textContent = 'ZAI · FREE';
  ui.helpDetail.textContent = '點擊切換聆聽 · 說完自動執行';

  let voiceMode = false;
  let recognition = null;

  const Ctor = getRecognitionCtor();
  if (Ctor) {
    recognition = new Ctor();
    recognition.lang = 'zh-TW';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
  }

  const session = createVoiceSession({
    systemPrompt:
      '你是「上帝之眼」台灣即時情資儀表板的語音助理，能透過工具直接控制地圖：' +
      '飛往地點、調整視角、開關圖層、查看 CCTV 攝影機、追蹤飛機等。' +
      '當使用者想移動地圖、查看資料或操作儀表板時，一律呼叫對應工具（不要用文字描述動作），' +
      '工具執行完成後只回一句繁體中文短語確認（十五個字以內，例如「帶你去看台北 101」）。' +
      '無法用工具完成的需求，用繁體中文簡短回答並引導回情資查詢。',
    chat: createChatClient({ fetchImpl, apiBase }),
    executeAction: runner
      ? (name, args) => runner(name, args)
      : (name, args) => executeMapAction(name, args),
    speak: createSpeaker({ fetchImpl, apiBase, audioFactory }),
    notify: (event) => {
      const mapped = mapEventToDock(event);
      if (mapped) {
        ui.root.dataset.status = mapped.status;
        ui.status.textContent = mapped.label;
        ui.detail.textContent = mapped.detail;
      }
      if (event.type === 'error') {
        ui.root.classList.remove('error-dismissed');
        if (ui.errorDetail) ui.errorDetail.textContent = event.message || '';
      }
      // Continuous conversation: while the toggle is on, re-arm the mic as
      // soon as the pipeline is idle again (thinking/speaking pause it so the
      // spoken reply is never fed back into recognition).
      if (event.type === 'idle' && voiceMode) restartListening();
    },
  });

  const stopListening = () => {
    try {
      recognition?.stop();
    } catch {
      /* already stopped */
    }
  };

  const restartListening = () => {
    if (!voiceMode || !recognition) return;
    if (session.startListening()) {
      try {
        recognition.start();
      } catch {
        session.stopListening();
      }
    }
  };

  const submitTranscript = (transcript) => {
    if (!transcript || session.state !== 'idle') return;
    // Pause the mic while the pipeline runs — the spoken reply must not be
    // recognized as the next command.
    stopListening();
    session.ask(transcript);
  };

  if (recognition) {
    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim && session.state === 'listening') {
        ui.detail.textContent = `「${interim}」…`;
      }
      if (final) submitTranscript(final.trim());
    };
    recognition.onerror = () => {
      if (session.state === 'listening') session.stopListening();
    };
    recognition.onend = () => {
      if (session.state === 'listening' && voiceMode) {
        // Browser cut us off (silence/permission) — re-arm while toggled on.
        try {
          recognition.start();
        } catch {
          session.stopListening();
        }
      }
    };
  }

  ui.button.addEventListener('click', () => {
    voiceMode = !voiceMode;
    if (voiceMode) {
      restartListening();
      if (session.state !== 'listening') {
        try {
          recognition?.start();
        } catch {
          /* re-arm loop handles it */
        }
      }
    } else {
      stopListening();
      session.cancel();
    }
  });

  return { session, ui };
}
