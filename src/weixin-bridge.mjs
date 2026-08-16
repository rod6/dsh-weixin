import {
  extractWeixinText,
  splitWeixinText,
  weixinMessageId,
} from './weixin-api.mjs';

const HELP_TEXT = [
  '微信已连接 DeepSeek Harness。',
  '',
  '直接发送文字或带文字识别结果的语音即可继续当前会话。',
  '/new  开启一个全新会话',
  '/status  检查连接状态',
  '/help  显示本帮助',
].join('\n');

function conversationKey(userId) {
  return `p2p:${userId}`;
}

const ALLOW_WORDS = new Set(['允许', '同意', '批准', '继续', '是', '好', 'ok', 'yes', 'allow', 'y', '1']);
const DENY_WORDS = new Set(['拒绝', '取消', '禁止', '否', '不', 'no', 'deny', 'stop', 'n', '0']);

/** Parse one inbound reply into an approval decision; null = not a decision. */
function parseApprovalAnswer(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (ALLOW_WORDS.has(normalized)) return true;
  if (DENY_WORDS.has(normalized)) return false;
  return null;
}

export function createWeixinBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null,
  };
}

export class WeixinHarnessBridge {
  #api;
  #baseUrl;
  #token;
  #ownerUserId;
  #harness;
  #state;
  #status;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #approvalTimeoutMs;
  #resultPreviewChars;
  #progressThrottleMs;
  #queues = new Map();
  #pendingApprovals = new Map();
  #pendingProgress = null;
  #progressTimer = null;
  #outbox = Promise.resolve();

  constructor({
    api,
    baseUrl,
    token,
    ownerUserId,
    harness,
    state,
    status = createWeixinBridgeStatus(),
    logger = console,
    replyTimeoutMs = 600_000,
    maxMessageChars = 4_000,
    approvalTimeoutMs = 300_000,
    resultPreviewChars = 150,
    progressThrottleMs = 1_500,
  }) {
    if (!api || typeof api.sendText !== 'function') throw new TypeError('Weixin API is required');
    if (!baseUrl || !token || !ownerUserId) throw new TypeError('Weixin account credentials are required');
    if (!harness || !state) throw new TypeError('Harness client and state store are required');
    this.#api = api;
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#ownerUserId = ownerUserId;
    this.#harness = harness;
    this.#state = state;
    this.#status = status;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
    this.#approvalTimeoutMs = approvalTimeoutMs;
    this.#resultPreviewChars = resultPreviewChars;
    this.#progressThrottleMs = progressThrottleMs;
  }

  get status() {
    return structuredClone(this.#status);
  }

  accept(message) {
    const sender = typeof message?.from_user_id === 'string' ? message.from_user_id : '';
    const previous = this.#queues.get(sender) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(message))
      .finally(() => {
        if (this.#queues.get(sender) === current) this.#queues.delete(sender);
      });
    this.#queues.set(sender, current);
    return current;
  }

  async waitForIdle() {
    await Promise.allSettled([...this.#queues.values()]);
  }

  /** Whether this account's mapped session is the given session. */
  ownsSession(sessionId) {
    return this.#state.sessionFor(conversationKey(this.#ownerUserId)) === sessionId;
  }

  /**
   * Answer one harness approval/request from this account's owner over WeChat:
   * sends the question, waits for the owner's 「允许」/「拒绝」 reply (or the
   * request signal / a timeout), and resolves with the closed outcome. The
   * returned promise CLAIMS the approval waterfall for this request.
   */
  async submitApproval(req) {
    const userId = this.#ownerUserId;
    const queue = this.#pendingApprovals.get(userId) ?? [];
    const entry = {
      req,
      serial: queue.length + 1,
      settled: false,
      resolve: null,
      timer: null,
      onAbort: null,
    };
    const pending = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    queue.push(entry);
    this.#pendingApprovals.set(userId, queue);

    // Register the abort listener BEFORE any await: an abort landing while the
    // question send is in flight would otherwise find no listener and leave
    // the request pending forever (the same window the harness answerer
    // guards). An already-aborted signal settles immediately.
    if (req.signal) {
      if (req.signal.aborted) {
        this.#settle(entry, 'cancelled');
        return pending;
      }
      entry.onAbort = () => this.#settle(entry, 'cancelled');
      req.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    entry.timer = setTimeout(() => this.#settle(entry, 'rejected'), this.#approvalTimeoutMs);

    const lines = [`🔒 需要你批准：${req.toolName}`];
    if (req.reason) lines.push(`原因：${req.reason}`);
    if (queue.length > 1) lines.push(`（第 ${entry.serial}/${queue.length} 个待批准请求）`);
    lines.push('回复「允许」继续，或「拒绝」取消。');
    try {
      await this.#send(userId, lines.join('\n'), undefined, undefined);
    } catch (error) {
      this.#logger.warn?.('[dsh-weixin] failed to send an approval question:', error);
    }
    return pending;
  }

  #settle(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    if (entry.req.signal && entry.onAbort) {
      entry.req.signal.removeEventListener('abort', entry.onAbort);
    }
    const queue = this.#pendingApprovals.get(this.#ownerUserId);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      if (queue.length === 0) this.#pendingApprovals.delete(this.#ownerUserId);
    }
    entry.resolve(outcome);
  }

  async #process(message) {
    if (message?.message_type === 2) return;
    const messageId = weixinMessageId(message);
    const sender = typeof message?.from_user_id === 'string' ? message.from_user_id : '';
    if (!messageId || !sender) return;
    if (this.#state.hasSeen(messageId)) return;

    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = new Date().toISOString();
    if (sender !== this.#ownerUserId) {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = new Date().toISOString();
      return;
    }

    const contextToken = typeof message.context_token === 'string' ? message.context_token : undefined;
    const runId = typeof message.run_id === 'string' ? message.run_id : undefined;
    const text = extractWeixinText(message);
    try {
      if (!text) {
        await this.#send(sender, '目前仅支持文字消息，以及微信已转成文字的语音消息。', contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }

      const pending = this.#pendingApprovals.get(sender);
      if (pending && pending.length > 0) {
        const decision = parseApprovalAnswer(text);
        if (decision !== null) {
          const entry = pending[0];
          const outcome = decision ? 'allowed-once' : 'rejected';
          await this.#send(sender, decision ? '✅ 已允许。' : '🚫 已拒绝。', contextToken, runId);
          await this.#state.markSeen(messageId);
          this.#settle(entry, outcome);
          return;
        }
        await this.#send(sender, `当前有 ${pending.length} 个待批准请求，请回复「允许」或「拒绝」。`, contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }

      const command = text.trim().toLowerCase();
      if (command === '/help') {
        await this.#send(sender, HELP_TEXT, contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === '/status') {
        await this.#harness.ensureRunning();
        await this.#send(sender, '微信与 DeepSeek Harness 连接正常。', contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === '/new') {
        await this.#state.clearSession(conversationKey(sender));
        await this.#send(sender, '已开启新会话。请发送你的问题。', contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }

      const key = conversationKey(sender);
      let sessionId = this.#state.sessionFor(key);
      if (!sessionId || !(await this.#harness.sessionExists(sessionId))) {
        sessionId = await this.#harness.createSession();
        await this.#state.setSession(key, sessionId);
      }
      const answer = await this.#harness.ask(sessionId, text, {
        timeoutMs: this.#replyTimeoutMs,
        resultPreviewChars: this.#resultPreviewChars,
        onUpdate: async (update) => {
          if (update?.type === 'tool' && typeof update.name === 'string') {
            await this.#forwardProgress(sender, `🔧 正在调用工具：${update.name}`, contextToken, runId);
          } else if (update?.type === 'status' && typeof update.text === 'string') {
            await this.#forwardProgress(sender, `⏳ ${update.text}`, contextToken, runId);
          }
        },
      });
      await this.#flushProgress(sender, contextToken, runId);
      await this.#send(sender, answer, contextToken, runId);
      await this.#state.markSeen(messageId);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = new Date().toISOString();
      this.#status.lastError = null;
    } catch (error) {
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.('[dsh-weixin] failed to process an inbound message:', error);
      try {
        await this.#send(sender, '消息处理失败，请稍后重试。', contextToken, runId);
        await this.#state.markSeen(messageId);
      } catch (sendError) {
        this.#logger.error?.('[dsh-weixin] failed to send the safe error reply:', sendError);
      }
    }
  }

  async #send(toUserId, text, contextToken, runId) {
    for (const chunk of splitWeixinText(text, this.#maxMessageChars)) {
      await this.#api.sendText({
        baseUrl: this.#baseUrl,
        token: this.#token,
        toUserId,
        text: chunk,
        contextToken,
        runId,
      });
    }
  }

  /**
   * Forward one live progress line, coalescing bursts: at most one progress
   * message per `progressThrottleMs`, always the latest pending line. Rapid
   * tool events (calls + results) collapse into a single message instead of
   * one message per event.
   */
  async #forwardProgress(toUserId, text, contextToken, runId) {
    if (this.#progressThrottleMs <= 0) {
      await this.#send(toUserId, text, contextToken, runId);
      return;
    }
    this.#pendingProgress = text;
    if (this.#progressTimer !== null) return;
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = null;
      const pending = this.#pendingProgress;
      this.#pendingProgress = null;
      if (pending) this.#enqueueProgress(toUserId, pending, contextToken, runId);
    }, this.#progressThrottleMs);
  }

  /** Send any throttled progress line now and wait for the outbox to drain. */
  async #flushProgress(toUserId, contextToken, runId) {
    if (this.#progressTimer !== null) {
      clearTimeout(this.#progressTimer);
      this.#progressTimer = null;
    }
    const pending = this.#pendingProgress;
    this.#pendingProgress = null;
    if (pending) this.#enqueueProgress(toUserId, pending, contextToken, runId);
    await this.#outbox;
  }

  #enqueueProgress(toUserId, text, contextToken, runId) {
    const send = () => this.#send(toUserId, text, contextToken, runId)
      .catch((error) => this.#logger.warn?.('[dsh-weixin] failed to send a progress message:', error));
    this.#outbox = this.#outbox.then(send, send);
  }
}
