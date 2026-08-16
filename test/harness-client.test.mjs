import assert from 'node:assert/strict';
import test from 'node:test';

import { HarnessReplyTracker } from '../src/harness-client.mjs';

test('reply tracker associates only the Harness turn created by the Weixin prompt RPC', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'weixin-prompt', afterSeq: 2 });
  const first = tracker.consume([
    { event: { seq: 3, type: 'turn/start', data: { turn: 9 } } },
    { event: {
      seq: 4,
      type: 'user/message',
      data: { turn: 9, source: { rpcId: 'weixin-prompt' } },
    } },
    { event: {
      seq: 5,
      type: 'assistant/chunk',
      data: { turn: 9, step: 0, chunk: { type: 'text-delta', index: 0, text: '微信' } },
    } },
  ]);
  assert.deepEqual(first, { type: 'text', text: '微信' });
  tracker.consume([
    { event: {
      seq: 6,
      type: 'assistant/message',
      data: { turn: 9, message: { content: [{ type: 'text', text: '微信回复完成' }] } },
    } },
    { event: { seq: 7, type: 'turn/end', data: { turn: 9, reason: 'completed' } } },
  ]);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.answer, '微信回复完成');
});

test('reply tracker ignores interleaved turns and older events', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'target', afterSeq: 10 });
  tracker.consume([
    { event: { seq: 9, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 11, type: 'turn/start', data: { turn: 2 } } },
    { event: { seq: 12, type: 'user/message', data: { turn: 2, source: { rpcId: 'other' } } } },
    { event: {
      seq: 13,
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: 'wrong' }] } },
    } },
  ]);
  assert.equal(tracker.answer, '');
  assert.equal(tracker.finished, false);
});

function toolResultEvent(seq, text) {
  return { event: {
    seq,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: text ? [{ type: 'text', text }] : [] }] },
    },
  } };
}

test('reply tracker forwards the actual tool result text instead of a placeholder', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'p', afterSeq: 0 });
  const call = tracker.consume([
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'p' } } } },
    { event: { seq: 3, type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'fetch' } } },
  ]);
  assert.deepEqual(call, { type: 'tool', name: 'fetch' });
  const result = tracker.consume([toolResultEvent(4, 'Fetch succeeded — title "具身智能中试"')]);
  assert.deepEqual(result, { type: 'status', text: 'fetch 完成：Fetch succeeded — title "具身智能中试"' });
});

test('reply tracker truncates long tool results to the preview limit', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'p', afterSeq: 0, resultPreviewChars: 10 });
  tracker.consume([
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'p' } } } },
    { event: { seq: 3, type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'read' } } },
  ]);
  const result = tracker.consume([toolResultEvent(4, '一二三四五六七八九十甲')]);
  assert.equal(result.type, 'status');
  assert.match(result.text, /read 完成：一二三四五六七八九十/);
  assert.match(result.text, /已截断/);
});

test('reply tracker falls back to a processing line when a tool result has no text', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'p', afterSeq: 0 });
  tracker.consume([
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'p' } } } },
    { event: { seq: 3, type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'bash' } } },
  ]);
  const result = tracker.consume([toolResultEvent(4, '')]);
  assert.deepEqual(result, { type: 'status', text: '正在整理bash的结果…' });
});

test('reply tracker flattens multi-line tool results into one compact preview line', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'p', afterSeq: 0 });
  tracker.consume([
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'p' } } } },
    { event: { seq: 3, type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'list' } } },
  ]);
  const result = tracker.consume([toolResultEvent(4, '第一行\n\n第二行\t带制表   收尾')]);
  assert.deepEqual(result, { type: 'status', text: 'list 完成：第一行 第二行 带制表 收尾' });
});

test('reply tracker caps previews at the default 150 characters', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'p', afterSeq: 0 });
  tracker.consume([
    { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 2, type: 'user/message', data: { turn: 1, source: { rpcId: 'p' } } } },
    { event: { seq: 3, type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'read' } } },
  ]);
  const result = tracker.consume([toolResultEvent(4, 'x'.repeat(200))]);
  assert.match(result.text, /read 完成：x{150}…（已截断）/);
});
