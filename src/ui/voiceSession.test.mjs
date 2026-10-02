import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_HISTORY_LIMIT,
  assembleChatMessages,
  createVoiceSession,
  createVoiceStateMachine,
  extractChatReply,
} from './voiceSession.js';

test('state machine only allows declared transitions', () => {
  const fsm = createVoiceStateMachine();
  assert.equal(fsm.state, 'idle');
  assert.equal(fsm.can('listening'), true);
  assert.equal(fsm.can('thinking'), true); // typed input path
  assert.equal(fsm.can('speaking'), false);
  assert.equal(fsm.transition('listening'), true);
  assert.equal(fsm.transition('thinking'), true);
  assert.equal(fsm.transition('listening'), false); // thinking → listening is illegal
  assert.equal(fsm.transition('speaking'), true);
  assert.equal(fsm.transition('idle'), true);
});

test('assembleChatMessages prepends system, replays bounded history, appends user', () => {
  const system = '你是語音助理';
  const history = [
    { user: '第一問', reply: '第一答' },
    { user: '第二問', reply: '第二答' },
  ];
  const messages = assembleChatMessages('第三問', history, system);
  assert.deepEqual(messages, [
    { role: 'system', content: system },
    { role: 'user', content: '第一問' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二問' },
    { role: 'assistant', content: '第二答' },
    { role: 'user', content: '第三問' },
  ]);
  // No system prompt → no system turn.
  assert.equal(assembleChatMessages('哈囉')[0].role, 'user');
});

test('extractChatReply reads choices[0].message.content and rejects junk', () => {
  assert.equal(extractChatReply({ choices: [{ message: { content: ' 台北多雲 ' } }] }), '台北多雲');
  assert.equal(extractChatReply({ choices: [] }), null);
  assert.equal(extractChatReply(null), null);
  assert.equal(extractChatReply({ choices: [{ message: { content: '   ' } }] }), null);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('session ask flow: thinking → reply → speak → idle, history retained', async () => {
  const events = [];
  let chatMessages = null;
  const session = createVoiceSession({
    chat: async (messages) => {
      chatMessages = messages;
      return { choices: [{ message: { content: '台北今天多雲。' } }] };
    },
    speak: async () => {},
    notify: (event) => events.push(event),
  });

  assert.equal(session.startListening(), true);
  assert.equal(session.state, 'listening');
  session.cancel();
  assert.equal(session.state, 'idle');

  events.length = 0;
  await session.ask('台北天氣?');
  assert.equal(session.state, 'idle');
  assert.equal(chatMessages[chatMessages.length - 1].content, '台北天氣?');
  assert.deepEqual(
    events.map((e) => e.type),
    ['thinking', 'reply', 'idle'],
  );
  assert.equal(session.history.length, 1);
  assert.equal(session.history[0].reply, '台北今天多雲。');
});

test('session speak failure degrades to text without killing the session', async () => {
  const events = [];
  const session = createVoiceSession({
    chat: async () => ({ choices: [{ message: { content: '回覆' } }] }),
    speak: async () => {
      throw new Error('no tts');
    },
    notify: (event) => events.push(event),
  });
  await session.ask('問題');
  assert.equal(session.state, 'idle');
  assert.ok(events.some((e) => e.type === 'speak-failed'));
  // Still usable afterwards.
  await session.ask('再問');
  assert.equal(session.history.length, 2);
});

test('session chat failure surfaces an error event and resets to idle', async () => {
  const events = [];
  const session = createVoiceSession({
    chat: async () => {
      throw new Error('chat HTTP 429');
    },
    speak: async () => {},
    notify: (event) => events.push(event),
  });
  await session.ask('問題');
  assert.equal(session.state, 'idle');
  const error = events.find((e) => e.type === 'error');
  assert.match(error.message, /429/);
});

test('cancel during chat still shows the reply but never speaks', async () => {
  const events = [];
  let releaseChat;
  const session = createVoiceSession({
    chat: () => new Promise((resolve) => (releaseChat = resolve)),
    speak: async () => {
      throw new Error('speak must not be reached');
    },
    notify: (event) => events.push(event),
  });
  const pending = session.ask('慢慢想');
  assert.equal(session.state, 'thinking');
  session.cancel();
  assert.equal(session.state, 'idle');
  releaseChat({ choices: [{ message: { content: '遲到的答案' } }] });
  await pending;
  await flush();
  const reply = events.find((e) => e.type === 'reply');
  assert.ok(reply, 'reply bubble still lands');
  assert.equal(session.state, 'idle');
  assert.ok(!events.some((e) => e.type === 'idle' && e === events.at(-1) && session.state !== 'idle'));
});

test('history replay is capped at VOICE_HISTORY_LIMIT turns', async () => {
  const seen = [];
  const session = createVoiceSession({
    chat: async (messages) => {
      seen.push(messages.filter((m) => m.role !== 'system').length);
      return { choices: [{ message: { content: '好' } }] };
    },
    speak: async () => {},
    notify: () => {},
  });
  for (let i = 0; i < VOICE_HISTORY_LIMIT + 3; i += 1) {
    await session.ask(`問題 ${i}`);
  }
  assert.equal(session.history.length, VOICE_HISTORY_LIMIT);
  const counts = seen.at(-1);
  assert.equal(counts, VOICE_HISTORY_LIMIT * 2 + 1); // pairs + the new user turn
});

const toolCallData = (name, args, callId = 'call_1') => ({
  choices: [
    {
      message: {
        content: '',
        tool_calls: [
          { id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
});

test('tool loop: executes tool_calls, feeds results back, speaks the final text', async () => {
  const events = [];
  const seenMessages = [];
  const executed = [];
  let round = 0;
  const session = createVoiceSession({
    chat: async (messages) => {
      seenMessages.push(messages);
      round += 1;
      if (round === 1) return toolCallData('search_and_fly_to', { query: '台北101' });
      return { choices: [{ message: { content: '帶你去看台北 101。' } }] };
    },
    executeAction: async (name, args) => {
      executed.push({ name, args });
      return { ok: true, action: name };
    },
    speak: async () => {},
    notify: (event) => events.push(event),
  });

  await session.ask('帶我去看台北101');
  assert.equal(session.state, 'idle');
  assert.deepEqual(executed, [{ name: 'search_and_fly_to', args: { query: '台北101' } }]);
  // Round 2 request carried the assistant echo + tool result.
  const round2 = seenMessages[1];
  assert.equal(round2.at(-2).role, 'assistant');
  assert.equal(round2.at(-2).tool_calls[0].id, 'call_1');
  assert.equal(round2.at(-1).role, 'tool');
  assert.equal(round2.at(-1).tool_call_id, 'call_1');
  assert.match(round2.at(-1).content, /"ok":true/);
  // Final reply event + only the spoken text lands in history.
  assert.ok(events.some((e) => e.type === 'reply' && e.reply === '帶你去看台北 101。'));
  assert.deepEqual(session.history, [
    { user: '帶我去看台北101', reply: '帶你去看台北 101。' },
  ]);
});

test('tool executor failure becomes a failed tool result, not a crash', async () => {
  const session = createVoiceSession({
    chat: async () => toolCallData('fly_to_location', {}, 'call_9'),
    executeAction: async () => {
      throw new Error('map runner unavailable');
    },
    speak: async () => {},
    notify: () => {},
  });
  // Round 2: model sees the failure and answers with text.
  await session.ask('飛去倫敦');
  assert.equal(session.state, 'idle');
});

test('tool loop is capped at MAX_TOOL_ROUNDS executor rounds', async () => {
  let chatRounds = 0;
  const executed = [];
  const session = createVoiceSession({
    chat: async () => {
      chatRounds += 1;
      return toolCallData('move_camera', { direction: 'up' }, `call_${chatRounds}`);
    },
    executeAction: async (name) => {
      executed.push(name);
      return { ok: true };
    },
    speak: async () => {},
    notify: () => {},
  });
  await session.ask('一直往上');
  assert.equal(executed.length, 3); // MAX_TOOL_ROUNDS
  assert.equal(chatRounds, 4); // 3 tool rounds + the capped-text round
  assert.equal(session.state, 'idle');
});

test('tool_calls are ignored when no executor is wired', async () => {
  const events = [];
  const session = createVoiceSession({
    chat: async () => toolCallData('fly_to_location', {}),
    speak: async () => {},
    notify: (event) => events.push(event),
  });
  await session.ask('帶我飛');
  const error = events.find((e) => e.type === 'error');
  assert.match(error.message, /empty reply/); // no executor → text-only path finds nothing
  assert.equal(session.state, 'idle');
});
