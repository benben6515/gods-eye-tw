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
 * session, or null when SpeechRecognition is unavailable — then the text
 * input remains the only entrypoint.
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
  const textPlaceholder = () =>
    getVoiceLang() === 'zh' ? '或直接輸入指令…' : '…or type a command';
  ui.textInput.placeholder = textPlaceholder();

  let recognition = null;
  let recording = false;
  let heard = ''; // best transcript so far for the current recording
  // Submit waits for Chrome to flush the final transcript (it arrives just
  // before onend, i.e. after stop()) — onEndWaiter bridges that handshake.
  let onEndWaiter = null;
  let flushing = false;

  const Ctor = getRecognitionCtor();

  /**
   * A FRESH recognition instance per recording. Reusing one instance across
   * sessions breaks silently in Chrome once an <audio> playback happened in
   * between (TTS reply) — start() succeeds but no events ever fire. Known
   * bug class; the standard workaround is rebuild-per-session.
   */
  const buildRecognition = () => {
    if (!Ctor) return null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        /* already dead */
      }
    }
    const rec = new Ctor();
    rec.lang = voiceLangConfig().stt;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
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
    rec.onerror = (event) => {
      if (recording) {
        stopListening();
        session.stopListening();
        ui.detail.textContent =
          event?.error === 'no-speech'
            ? '沒聽到聲音，再試一次。'
            : '麥克風不可用。';
      }
    };
    rec.onend = () => {
      recording = false;
      const waiter = onEndWaiter;
      onEndWaiter = null;
      waiter?.();
    };
    recognition = rec;
    return rec;
  };

  const session = createVoiceSession({
    systemPrompt: () => voiceLangConfig().prompt,
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
    const rec = buildRecognition(); // fresh instance per session (Chrome bug)
    if (rec) rec.lang = voiceLangConfig().stt; // 中/EN live switch
    try {
      rec?.start();
    } catch {
      recording = false;
      session.stopListening();
    }
  };

  const submitHeard = () => {
    if (flushing) return; // second click while waiting for the flush
    const finish = () => {
      flushing = false;
      collapseDock();
      const text = heard.trim();
      heard = '';
      if (!text) {
        // Nothing recognized — settle back to idle with a hint that names
        // the active STT language (a zh speaker left in EN mode sees this).
        session.stopListening();
        ui.detail.textContent =
          `沒有聽到內容（語音語言：${getVoiceLang() === 'zh' ? '中文' : 'English'}）。`;
        return;
      }
      ui.detail.textContent = `「${text}」`;
      session.ask(text); // listening → thinking; mic already stopped
    };
    if (recognition && recording) {
      flushing = true;
      stopListening(); // stop() → final result → onend (async)
      onEndWaiter = finish;
      setTimeout(() => {
        if (onEndWaiter === finish) {
          onEndWaiter = null;
          finish();
        }
      }, 700);
    } else {
      finish();
    }
  };

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
    ui.textInput.placeholder = textPlaceholder();
    ui.detail.textContent = next === 'zh' ? '語音切換：中文' : 'Voice: English';
  });

  // Mobile Shell: the collapsed dock row expands into the status sheet (see
  // mobile-shell.css). A submitted command collapses it again — the map is
  // the point.
  const commandDock = documentImpl.getElementById('command-dock');
  let dockExpanded = false;
  const collapseDock = () => {
    dockExpanded = false;
    commandDock?.classList.remove('dock-expanded');
    ui.expandButton?.setAttribute('aria-expanded', 'false');
  };
  ui.expandButton?.addEventListener('click', () => {
    dockExpanded = !dockExpanded;
    commandDock?.classList.toggle('dock-expanded', dockExpanded);
    ui.expandButton.setAttribute('aria-expanded', String(dockExpanded));
  });

  // Quick Places (Mobile Shell P3): preset fly-to chips. They fly through
  // the same gevActions runner the voice tools use — no GLM round trip, the
  // camera just goes. Present only when a runner exists.
  const QUICK_PLACES = [
    { code: 'TPE 101', zh: '台北 101', latitude: 25.033, longitude: 121.5654, rangeM: 1200 },
    { code: 'KHH PORT', zh: '高雄港', latitude: 22.605, longitude: 120.29, rangeM: 3500 },
    { code: 'MZG', zh: '澎湖', latitude: 23.571, longitude: 119.57, rangeM: 30000 },
    { code: 'SML', zh: '日月潭', latitude: 23.865, longitude: 120.928, rangeM: 5000 },
    { code: 'CCK', zh: '清泉崗', latitude: 24.264, longitude: 120.621, rangeM: 4000 },
    { code: 'KTNT', zh: '墾丁', latitude: 21.95, longitude: 120.79, rangeM: 12000 },
  ];
  const flyToQuickPlace = runner
    ? (name, args) => runner(name, args)
    : (name, args) => executeMapAction(name, args);
  const quickPlaces = ui.root.querySelector('#gev-quick-places');
  for (const place of runner ? QUICK_PLACES : []) {
    const chip = documentImpl.createElement('button');
    chip.type = 'button';
    chip.className = 'gev-quick-place';
    chip.innerHTML = `<span class="gev-qp-code">${place.code}</span><span class="gev-qp-zh">${place.zh}</span>`;
    chip.addEventListener('click', () => {
      ui.detail.textContent = `飛往 ${place.zh}…`;
      collapseDock();
      Promise.resolve(
        flyToQuickPlace('fly_to_location', {
          latitude: place.latitude,
          longitude: place.longitude,
          rangeM: place.rangeM,
        }),
      ).catch(() => {});
    });
    quickPlaces?.appendChild(chip);
  }

  // Text fallback — types a command when the mic path is unavailable.
  const askText = () => {
    const text = ui.textInput.value.trim();
    if (!text) return;
    if (session.state === 'listening') session.stopListening();
    if (session.state !== 'idle') return; // thinking/speaking — busy
    collapseDock();
    ui.textInput.value = '';
    ui.detail.textContent = `「${text}」`;
    session.ask(text); // idle → thinking
  };
  ui.textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') askText();
  });

  return { session, ui };
}
