import { createVoiceControl } from '../voice/control.js';
import { createVoiceSession } from './voiceSession.js';
import {
  createChatClient,
  createSpeaker,
  executeMapAction,
} from './voiceTransports.js';
import { voiceLangConfig, getVoiceLang, setVoiceLang } from './voiceLang.js';
import { t, QUICK_PLACES, placeName } from './uiStrings.js';

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
      return { status: 'listening', label: 'LISTENING', detail: t('listening') };
    case 'thinking':
      return { status: 'executing', label: 'EXECUTING', detail: t('thinking') };
    case 'tool':
      return { status: 'executing', label: 'EXECUTING', detail: t('runningAction')(event.name) };
    case 'reply':
      return { status: 'executing', label: 'SPEAKING', detail: event.reply };
    case 'speak-failed':
      return { status: 'idle', label: 'OFF', detail: t('speakUnavailable') };
    case 'error':
      return { status: 'error', label: 'ERROR', detail: event.message || t('voiceError') };
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
  ui.tierButton.textContent = t('switchTo');
  ui.tierButton.title = 'Switch voice language';
  ui.costValue.textContent = 'ZAI · FREE';
  ui.helpDetail.textContent = t('helpRecord');
  const textPlaceholder = () => t('textPlaceholder');
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
            ? t('noSpeech')
            : t('micUnavailable');
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
        ui.detail.textContent = t('nothingHeard');
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
    ui.tierButton.textContent = t('switchTo');
    ui.textInput.placeholder = textPlaceholder();
    ui.helpDetail.textContent = t('helpRecord');
    ui.root
      .querySelector('#gev-quick-places')
      ?.setAttribute('aria-label', t('quickPlaces'));
    ui.expandButton?.setAttribute('aria-label', t('expandVoice'));
    ui.detail.textContent = t('switched');
    renderQuickPlaces();
    // Everything else (drawer layer names, …) follows the same switch.
    documentImpl.dispatchEvent?.(new Event('gev-lang-change'));
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
  // camera just goes. Present only when a runner exists. Re-rendered on a
  // language switch so the place names follow the 中/EN state.
  const flyToQuickPlace = runner
    ? (name, args) => runner(name, args)
    : (name, args) => executeMapAction(name, args);
  const quickPlaces = ui.root.querySelector('#gev-quick-places');
  // Chips are built once and relabeled in place on a language switch —
  // clearing innerHTML is hostile to the stub-DOM test harness.
  const chipRefs = [];
  const renderQuickPlaces = () => {
    if (!quickPlaces || !runner) return;
    if (chipRefs.length === 0) {
      for (const place of QUICK_PLACES) {
        const chip = documentImpl.createElement('button');
        chip.type = 'button';
        chip.className = 'gev-quick-place';
        const code = documentImpl.createElement('span');
        code.className = 'gev-qp-code';
        code.textContent = place.code;
        const label = documentImpl.createElement('span');
        label.className = 'gev-qp-zh';
        chip.appendChild(code);
        chip.appendChild(label);
        chip.addEventListener('click', () => {
          ui.detail.textContent = t('flyTo')(placeName(place));
          collapseDock();
          Promise.resolve(
            flyToQuickPlace('fly_to_location', {
              latitude: place.latitude,
              longitude: place.longitude,
              rangeM: place.rangeM,
            }),
          ).catch(() => {});
        });
        quickPlaces.appendChild(chip);
        chipRefs.push({ place, label });
      }
      return;
    }
    for (const { place, label } of chipRefs)
      label.textContent = placeName(place);
  };
  renderQuickPlaces();

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
