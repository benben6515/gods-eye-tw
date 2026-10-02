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
      return '台北今天多雲。';
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
    chat: async () => '回覆',
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
  releaseChat('遲到的答案');
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
      return '好';
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
