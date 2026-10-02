import { createVoiceControl } from '../voice/control.js';
import { createVoiceSession } from './voiceSession.js';
import {
  createChatClient,
  createSpeaker,
  executeMapAction,
} from './voiceTransports.js';
import { voiceLangConfig, getVoiceLang, setVoiceLang } from './voiceLang.js';

/**
 * The dock voice UI (the original God's Eye mic) reborn on the self-hosted
 * stack: same look — AI AGENT heading, mic button, visualizer, readout —
 * but the brain is GLM via /chat/completions (function calling drives the
 * map) and the voice is edge-tts. No OpenAI anywhere.
 *
 * Interaction: click once to record, click again to submit what was heard.
 * The mic is paused while the pipeline thinks/speaks so the spoken reply is
 * never fed back into recognition.
 */

/** Map a session event to the dock's dataset.status / label / readout text. */
export function mapEventToDock(event) {
  switch (event?.type) {
    case 'listening':
      return { status: 'listening', label: 'LISTENING', detail: '聆聽中…再點一下送出' };
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
  // The heading tier slot becomes the 中/EN language switch.
  ui.tierButton.hidden = false;
  ui.tierButton.textContent = getVoiceLang() === 'zh' ? 'EN' : '中文';
  ui.tierButton.title = 'Switch voice language';
  ui.costValue.textContent = 'ZAI · FREE';
  ui.helpDetail.textContent = '點一下開始錄音 · 再點一下送出';

  let recognition = null;
  let recording = false;
  let heard = ''; // best transcript so far for the current recording

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
        if (!(event.type === 'idle' && heard)) ui.detail.textContent = mapped.detail;
      }
      if (event.type === 'error') {
        ui.root.classList.remove('error-dismissed');
        if (ui.errorDetail) ui.errorDetail.textContent = event.message || '';
      }
    },
  });

  const stopListening = () => {
    recording = false;
    try {
      recognition?.stop();
    } catch {
      /* already stopped */
    }
  };

  const startRecording = () => {
    if (!session.startListening()) return;
    recording = true;
    heard = '';
    if (recognition) recognition.lang = voiceLangConfig().stt; // 中/EN live switch
    try {
      recognition?.start();
    } catch {
      recording = false;
      session.stopListening();
    }
  };

  const submitHeard = () => {
    stopListening();
    const text = heard.trim();
    heard = '';
    if (!text) {
      // Nothing recognized — settle back to idle with a hint.
      session.stopListening();
      ui.detail.textContent = '沒有聽到內容，再試一次。';
      return;
    }
    ui.detail.textContent = `「${text}」`;
    session.ask(text); // listening → thinking; mic already stopped
  };

  if (recognition) {
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) heard = transcript.trim();
        else if (!heard) heard = transcript; // interim — replaced by the final
        if (session.state === 'listening') {
          ui.detail.textContent = `「${heard || transcript}」…`;
        }
      }
    };
    recognition.onerror = () => {
      if (recording) {
        stopListening();
        session.stopListening();
        ui.detail.textContent = '麥克風不可用。';
      }
    };
    recognition.onend = () => {
      recording = false;
    };
  }

  ui.button.addEventListener('click', () => {
    if (session.state === 'idle') {
      startRecording();
    } else if (session.state === 'listening') {
      submitHeard();
    }
    // thinking/speaking: busy — ignore extra clicks
  });

  ui.tierButton.addEventListener('click', () => {
    const next = getVoiceLang() === 'zh' ? 'en' : 'zh';
    setVoiceLang(next);
    ui.tierButton.textContent = next === 'zh' ? 'EN' : '中文';
    ui.detail.textContent = next === 'zh' ? '語音切換：中文' : 'Voice: English';
  });

  return { session, ui };
}
