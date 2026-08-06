'use strict';

const assert = require('node:assert/strict');
const Surface = require('./torsionfield-chatgpt-conversation-surface.js');

function identity(key = 'https://chatgpt.com/c/conversation-a', durable = true) {
  return { key, origin: 'https://chatgpt.com', isDurableConversation: durable };
}

function snapshot(overrides = {}) {
  return {
    identity: identity(),
    userTurnCount: 1,
    assistantTurnCount: 1,
    userTurnTexts: ['old prompt'],
    latestAssistantHash: 'old-answer',
    streaming: false,
    ...overrides,
  };
}

assert.equal(Surface.VERSION, '0.1.1-live');
assert.deepEqual(
  Surface.parseConversationIdentity('https://chatgpt.com/c/abc-123?model=gpt-5'),
  {
    origin: 'https://chatgpt.com',
    path: '/c/abc-123',
    conversationId: 'abc-123',
    key: 'https://chatgpt.com/c/abc-123',
    isDurableConversation: true,
  },
);
assert.equal(
  Surface.parseConversationIdentity('https://chatgpt.com/').isDurableConversation,
  false,
);

assert.deepEqual(
  Surface.pureOutcomeClassification(
    snapshot(),
    snapshot({ userTurnCount: 2, assistantTurnCount: 2, userTurnTexts: ['old prompt', 'new prompt'], latestAssistantHash: 'new-answer' }),
    'new prompt',
  ),
  { status: 'CONFIRMED', reason: 'prompt-and-settled-assistant-effect-observed' },
);

assert.deepEqual(
  Surface.pureOutcomeClassification(snapshot(), snapshot(), 'new prompt'),
  { status: 'NOT_APPLIED', reason: 'baseline-unchanged-and-prompt-absent' },
);

assert.deepEqual(
  Surface.pureOutcomeClassification(
    snapshot(),
    snapshot({ userTurnCount: 2, userTurnTexts: ['old prompt', 'new prompt'], streaming: true }),
    'new prompt',
  ),
  { status: 'PARTIAL', reason: 'effect-observed-response-still-streaming' },
);

assert.deepEqual(
  Surface.pureOutcomeClassification(
    snapshot(),
    snapshot({ identity: identity('https://chatgpt.com/c/conversation-b') }),
    'new prompt',
  ),
  { status: 'UNKNOWN_OUTCOME', reason: 'conversation-identity-changed' },
);

assert.deepEqual(
  Surface.pureOutcomeClassification(
    snapshot({
      identity: identity('https://chatgpt.com/', false),
      userTurnCount: 0,
      assistantTurnCount: 0,
      userTurnTexts: [],
      latestAssistantHash: '',
    }),
    snapshot({
      identity: identity('https://chatgpt.com/c/new-conversation', true),
      userTurnCount: 1,
      assistantTurnCount: 1,
      userTurnTexts: ['new prompt'],
      latestAssistantHash: 'new-answer',
    }),
    'new prompt',
  ),
  { status: 'CONFIRMED', reason: 'prompt-and-settled-assistant-effect-observed' },
);

assert.deepEqual(
  Surface.pureOutcomeClassification(
    snapshot(),
    snapshot({
      userTurnCount: 2,
      assistantTurnCount: 2,
      userTurnTexts: ['old prompt', 'new prompt  <contract> line one line two </contract>'],
      latestAssistantHash: 'new-answer',
    }),
    'new prompt\n\n<contract>\nline one\nline two\n</contract>',
  ),
  { status: 'CONFIRMED', reason: 'prompt-and-settled-assistant-effect-observed' },
);

assert.deepEqual(
  Surface.pureOutcomeClassification(
    snapshot(),
    snapshot({ userTurnCount: 2, userTurnTexts: ['old prompt', 'different prompt'] }),
    'new prompt',
  ),
  { status: 'UNKNOWN_OUTCOME', reason: 'page-shows-incomplete-or-ambiguous-effect' },
);

assert.equal(Surface.normalizeText(' a\r\n b '), 'a\n b');
assert.equal(Surface.normalizeCorrelationText(' a\n  b '), 'a b');
assert.equal(Surface.fnv1a64('abc'), 'e71fa2190541574b');

console.log(JSON.stringify({
  ok: true,
  version: Surface.VERSION,
  assertions: 13,
  purpose: 'submission outcome is classified by re-observing the exact conversation',
}));
