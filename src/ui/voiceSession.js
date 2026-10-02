/**
 * Headless voice-console orchestration: state machine, chat payload
 * assembly, reply extraction and the ask→reply→speak flow.
 *
 * Everything here is DOM-free and transport-free — callers inject `chat`
 * (transcript → reply text), `speak` (reply text → playback promise) and
 * `notify` (UI event sink). The DOM adapter lives in voiceConsole.js; the
 * split mirrors controls/presentation elsewhere in this codebase and keeps
 * the flow unit-testable without a browser.
 */

export const VOICE_STATES = Object.freeze([
  'idle',
  'listening',
  'thinking',
  'speaking',
]);

/** Legal transitions. Typed input goes idle→thinking directly; `cancel` retreats from any non-idle state. */
const TRANSITIONS = Object.freeze({
  idle: ['listening', 'thinking'],
  listening: ['thinking', 'idle'],
  thinking: ['speaking', 'idle'],
  speaking: ['idle'],
});

/**
 * A tiny explicit FSM — the console UI keys off `state`, and every async
 * completion funnels through `transition` so late resolutions (a chat reply
 * landing after cancel) are dropped instead of corrupting the UI.
 */
export function createVoiceStateMachine(initial = 'idle') {
  let state = initial;
  return {
    get state() {
      return state;
    },
    can(next) {
      return (TRANSITIONS[state] || []).includes(next);
    },
    /** @returns {boolean} false when the transition is illegal (caller drops the stale event). */
    transition(next) {
      if (!this.can(next)) return false;
      state = next;
      return true;
    },
  };
}

/** Turn a transcript + rolling history into an OpenAI-shaped messages array. */
export function assembleChatMessages(transcript, history = [], systemPrompt = '') {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const turn of history) {
    if (turn?.user) messages.push({ role: 'user', content: turn.user });
    if (turn?.reply) messages.push({ role: 'assistant', content: turn.reply });
  }
  messages.push({ role: 'user', content: transcript });
  return messages;
}

/** Extract the reply text from an OpenAI-compatible completion response. */
export function extractChatReply(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim()
    ? content.trim()
    : null;
}

/** Only the most recent turns are replayed — the console is a helper, not an archive. */
export const VOICE_HISTORY_LIMIT = 6;

/**
 * The ask→reply→speak loop with cancel-safe late events.
 * @param {object} ports
 * @param {(messages: Array) => Promise<string>} ports.chat transcript-in, reply-text-out (throws on failure)
 * @param {(text: string) => Promise<void>} ports.speak reply-text-out, resolves when playback ends (throws when TTS unavailable)
 * @param {(event: object) => void} ports.notify UI sink: {type, ...}
 */
export function createVoiceSession({ chat, speak, notify }) {
  const fsm = createVoiceStateMachine();
  const history = [];

  async function ask(transcript) {
    if (!fsm.transition('thinking')) return; // e.g. cancel raced the submit
    notify({ type: 'thinking', transcript });
    try {
      const reply = await chat(
        assembleChatMessages(transcript, history.slice(-VOICE_HISTORY_LIMIT)),
      );
      if (!reply) throw new Error('empty reply');
      history.push({ user: transcript, reply });
      if (history.length > VOICE_HISTORY_LIMIT) history.shift();
      if (fsm.transition('speaking')) {
        notify({ type: 'reply', reply });
        let speakFailed = false;
        try {
          await speak(reply);
        } catch {
          speakFailed = true; // text reply already shown — keep going
        }
        fsm.transition('idle');
        notify({ type: 'idle' });
        // Emitted after idle so the degradation notice is the last word and
        // survives the status clear (cleared again on the next interaction).
        if (speakFailed) notify({ type: 'speak-failed' });
      } else {
        // Cancelled while chatting: surface the answer, skip the speech.
        notify({ type: 'reply', reply });
      }
    } catch (error) {
      fsm.transition('idle');
      notify({ type: 'error', message: error?.message || String(error) });
    }
  }

  return {
    get state() {
      return fsm.state;
    },
    get history() {
      return history.slice();
    },
    /** Begin listening (illegal from thinking/speaking — the mic is busy). */
    startListening() {
      if (!fsm.transition('listening')) return false;
      notify({ type: 'listening' });
      return true;
    },
    stopListening() {
      fsm.transition('idle');
      notify({ type: 'idle' });
    },
    ask,
    /** Hard reset from any state; in-flight results are dropped by the FSM. */
    cancel() {
      fsm.transition('idle');
      notify({ type: 'idle' });
    },
  };
}
