import assert from 'node:assert/strict';
import test from 'node:test';

import { createWeixinBridgeStatus, WeixinHarnessBridge } from '../src/weixin-bridge.mjs';

function message(id, text, overrides = {}) {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: 'owner-user',
    context_token: `context-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  };
}

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessions,
    seen,
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
    },
  };
}

test('bridge maps the scanning Weixin user to one persistent Harness session and echoes context_token', async () => {
  const sent = [];
  const asked = [];
  const fixture = stateFixture();
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async (sessionId) => sessionId === 'session-1',
      createSession: async () => 'session-1',
      ask: async (sessionId, text) => {
        asked.push({ sessionId, text });
        return 'Harness 的回答';
      },
    },
    state: fixture.state,
    status,
  });

  await bridge.accept(message('1', '你好'));
  await bridge.accept(message('2', '继续'));

  assert.deepEqual(asked, [
    { sessionId: 'session-1', text: '你好' },
    { sessionId: 'session-1', text: '继续' },
  ]);
  assert.equal(fixture.sessions.get('p2p:owner-user'), 'session-1');
  assert.deepEqual(sent.map(({ toUserId, text, contextToken }) => ({ toUserId, text, contextToken })), [
    { toUserId: 'owner-user', text: 'Harness 的回答', contextToken: 'context-1' },
    { toUserId: 'owner-user', text: 'Harness 的回答', contextToken: 'context-2' },
  ]);
  assert.equal(status.messagesReceived, 2);
  assert.equal(status.messagesReplied, 2);
});

test('bridge rejects every user except the account owner returned by QR login', async () => {
  const fixture = stateFixture();
  let asked = 0;
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => assert.fail('unauthorized users must not receive a reply') },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: { ask: async () => { asked += 1; } },
    state: fixture.state,
    status,
  });

  await bridge.accept(message('unauthorized', '越权', { from_user_id: 'other-user' }));
  assert.equal(asked, 0);
  assert.equal(status.messagesRejected, 1);
});

test('bridge commands are local and internal failures return a generic message', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('p2p:owner-user', 'old-session');
  const sent = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request.text) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async () => { throw new Error('private path /secret and token-shaped detail'); },
    },
    state: fixture.state,
    logger: { error() {} },
  });

  await bridge.accept(message('new', '/new'));
  assert.equal(fixture.sessions.has('p2p:owner-user'), false);
  await bridge.accept(message('failure', '触发失败'));
  assert.match(sent.at(-1), /消息处理失败/);
  assert.doesNotMatch(sent.at(-1), /private path|secret|token-shaped/);
});

function approvalBridge({ approvalTimeoutMs = 60_000, logger = { warn() {} } } = {}) {
  const sent = [];
  const fixture = stateFixture();
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async () => 'final-answer',
    },
    state: fixture.state,
    status,
    logger,
    approvalTimeoutMs,
  });
  return { bridge, sent, fixture };
}

function approvalRequest(sessionId, { toolName = 'bash', reason = '写文件', signal } = {}) {
  return {
    agent: { session: { id: sessionId } },
    toolName,
    reason,
    signal,
  };
}

test('approval: the question reaches WeChat and 允许 settles allowed-once', async () => {
  const { bridge, sent } = approvalBridge();
  const outcome = bridge.submitApproval(approvalRequest('session-1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /需要你批准：bash/);
  assert.match(sent[0].text, /原因：写文件/);
  assert.match(sent[0].text, /允许/);
  await bridge.accept(message('allow-1', '允许'));
  assert.equal(await outcome, 'allowed-once');
});

test('approval: 拒绝 settles rejected', async () => {
  const { bridge } = approvalBridge();
  const outcome = bridge.submitApproval(approvalRequest('session-1'));
  await bridge.accept(message('deny-1', '拒绝'));
  assert.equal(await outcome, 'rejected');
});

test('approval: non-answer while pending gets a hint and stays pending', async () => {
  const { bridge, sent } = approvalBridge();
  const outcome = bridge.submitApproval(approvalRequest('session-1'));
  await new Promise((resolve) => setImmediate(resolve));
  const before = sent.length;
  await bridge.accept(message('smalltalk-1', '你好吗'));
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).text, /待批准/);
  await bridge.accept(message('allow-2', '允许'));
  assert.equal(await outcome, 'allowed-once');
});

test('approval: pending request times out to rejected', async () => {
  const { bridge } = approvalBridge({ approvalTimeoutMs: 20 });
  const outcome = bridge.submitApproval(approvalRequest('session-1'));
  assert.equal(await outcome, 'rejected');
});

test('approval: an abort signal settles cancelled (already aborted and mid-flight)', async () => {
  const { bridge } = approvalBridge();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const first = bridge.submitApproval(approvalRequest('session-1', { signal: alreadyAborted.signal }));
  assert.equal(await first, 'cancelled');

  const midFlight = new AbortController();
  const second = bridge.submitApproval(approvalRequest('session-1', { signal: midFlight.signal }));
  midFlight.abort();
  assert.equal(await second, 'cancelled');
});

test('approval: concurrent approvals resolve FIFO in reply order', async () => {
  const { bridge } = approvalBridge();
  const first = bridge.submitApproval(approvalRequest('session-1', { toolName: 'bash' }));
  const second = bridge.submitApproval(approvalRequest('session-1', { toolName: 'read' }));
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.accept(message('allow-3', '允许'));
  assert.equal(await first, 'allowed-once');
  await bridge.accept(message('deny-2', '拒绝'));
  assert.equal(await second, 'rejected');
});

test('approval: normal messages resume once every approval settled', async () => {
  const asked = [];
  const fixture = stateFixture();
  const status = createWeixinBridgeStatus();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async () => {} },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => false,
      createSession: async () => 'session-1',
      ask: async (sessionId, text) => { asked.push({ sessionId, text }); return 'final-answer'; },
    },
    state: fixture.state,
    status,
    logger: { warn() {} },
  });
  const outcome = bridge.submitApproval(approvalRequest('session-1'));
  await bridge.accept(message('allow-4', '允许'));
  assert.equal(await outcome, 'allowed-once');
  await bridge.accept(message('normal-1', '帮我算 1+1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [{ sessionId: 'session-1', text: '帮我算 1+1' }]);
});

test('approval: ownsSession matches only the mapped session', async () => {
  const { bridge, fixture } = approvalBridge();
  fixture.sessions.set('p2p:owner-user', 'session-a');
  assert.equal(bridge.ownsSession('session-a'), true);
  assert.equal(bridge.ownsSession('session-b'), false);
});

test("approval: a stranger cannot settle the owner's pending approval", async () => {
  const { bridge, sent } = approvalBridge();
  const outcome = bridge.submitApproval(approvalRequest('session-1'));
  await bridge.accept(message('intruder-1', '允许', { from_user_id: 'other-user' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.some(({ toUserId }) => toUserId === 'other-user'), false);
  await bridge.accept(message('allow-5', '允许'));
  assert.equal(await outcome, 'allowed-once');
});

function progressBridge({ progressThrottleMs = 1_500, ...rest } = {}) {
  const sent = [];
  const fixture = stateFixture();
  const status = createWeixinBridgeStatus();
  const updates = [];
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (_sessionId, _text, options) => {
        for (const update of updates) await options.onUpdate?.(update);
        return 'final-answer';
      },
    },
    state: fixture.state,
    status,
    progressThrottleMs,
    ...rest,
  });
  return { bridge, sent, updates, fixture };
}

test('progress: a burst of tool events collapses to the latest message before the answer', async () => {
  const { bridge, sent, updates } = progressBridge({ progressThrottleMs: 30 });
  updates.push(
    { type: 'tool', name: 'bash' },
    { type: 'status', text: 'bash 完成：结果' },
  );
  await bridge.accept(message('prog-1', '跑一下'));
  assert.deepEqual(sent.map(({ text }) => text), ['⏳ bash 完成：结果', 'final-answer']);
});

test('progress: events spaced beyond the throttle window produce one message per event', async () => {
  const sent = [];
  const fixture = stateFixture();
  const bridge = new WeixinHarnessBridge({
    api: { sendText: async (request) => sent.push(request) },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (_sessionId, _text, options) => {
        await options.onUpdate?.({ type: 'tool', name: 'bash' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        await options.onUpdate?.({ type: 'status', text: 'bash 完成：结果' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'final-answer';
      },
    },
    state: fixture.state,
    status: createWeixinBridgeStatus(),
    progressThrottleMs: 25,
  });
  await bridge.accept(message('prog-2', '跑一下'));
  assert.deepEqual(sent.map(({ text }) => text), [
    '🔧 正在调用工具：bash',
    '⏳ bash 完成：结果',
    'final-answer',
  ]);
});

test('progress: throttle disabled (0) sends every update immediately', async () => {
  const { bridge, sent, updates } = progressBridge({ progressThrottleMs: 0 });
  updates.push(
    { type: 'tool', name: 'bash' },
    { type: 'status', text: 'bash 完成：结果' },
  );
  await bridge.accept(message('prog-3', '跑一下'));
  assert.deepEqual(sent.map(({ text }) => text), [
    '🔧 正在调用工具：bash',
    '⏳ bash 完成：结果',
    'final-answer',
  ]);
});
