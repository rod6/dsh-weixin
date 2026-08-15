// plugin-src/host/production.mjs
import { unlink as unlink3 } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// src/config-store.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// src/weixin-api.mjs
import { randomBytes, randomUUID } from "node:crypto";
var WEIXIN_QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
var WEIXIN_PROTOCOL_VERSION = "2.4.6";
var DEFAULT_BOT_TYPE = "3";
var ILINK_APP_ID = "bot";
var ILINK_CLIENT_VERSION = 2 << 16 | 4 << 8 | 6;
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_LONG_POLL_TIMEOUT_MS = 35e3;
var LOGIN_STATUSES = /* @__PURE__ */ new Set([
  "wait",
  "scaned",
  "confirmed",
  "expired",
  "scaned_but_redirect",
  "need_verifycode",
  "verify_code_blocked",
  "binded_redirect"
]);
var WeixinApiError = class extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WeixinApiError";
    this.code = code;
    this.status = options.status;
  }
};
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isWeixinHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "weixin.qq.com" || normalized.endsWith(".weixin.qq.com");
}
function normalizeWeixinApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinApiError("invalid-base-url", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6548\u7684\u8FDE\u63A5\u5730\u5740\u3002");
  }
  if (url.protocol !== "https:" || !isWeixinHost(url.hostname) || url.port !== "" && url.port !== "443") {
    throw new WeixinApiError("untrusted-base-url", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u4E0D\u53D7\u4FE1\u4EFB\u7684\u8FDE\u63A5\u5730\u5740\u3002");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}
function normalizeWeixinQrUrl(value) {
  const text = nonEmptyString(value);
  if (!text) throw new WeixinApiError("invalid-qr", "\u5FAE\u4FE1\u670D\u52A1\u6CA1\u6709\u8FD4\u56DE\u626B\u7801\u5730\u5740\u3002");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WeixinApiError("invalid-qr", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6548\u7684\u626B\u7801\u5730\u5740\u3002");
  }
  if (url.protocol !== "https:" || !isWeixinHost(url.hostname)) {
    throw new WeixinApiError("untrusted-qr", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u4E0D\u53D7\u4FE1\u4EFB\u7684\u626B\u7801\u5730\u5740\u3002");
  }
  return url.toString();
}
function commonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION)
  };
}
function authenticatedHeaders(token) {
  const headers = {
    ...commonHeaders(),
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64")
  };
  if (nonEmptyString(token)) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}
function baseInfo() {
  return {
    channel_version: WEIXIN_PROTOCOL_VERSION,
    bot_agent: "DeepSeekHarness/0.1.0"
  };
}
function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}
async function requestJson(fetchImpl, {
  method,
  baseUrl,
  endpoint,
  body,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  authenticated = true
}) {
  const trustedBase = normalizeWeixinApiBaseUrl(baseUrl);
  const url = new URL(endpoint, trustedBase);
  if (!isWeixinHost(url.hostname)) {
    throw new WeixinApiError("untrusted-endpoint", "\u62D2\u7EDD\u8BBF\u95EE\u4E0D\u53D7\u4FE1\u4EFB\u7684\u5FAE\u4FE1\u670D\u52A1\u5730\u5740\u3002");
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw abortError(signal);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      method,
      headers: authenticated ? authenticatedHeaders(token) : commonHeaders(),
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new WeixinApiError(
        "http-error",
        `\u5FAE\u4FE1\u670D\u52A1\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\u3002`,
        { status: response.status }
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeixinApiError("invalid-response", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u54CD\u5E94\u3002", { cause: error });
    }
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (timedOut) {
      throw new WeixinApiError("timeout", "\u5FAE\u4FE1\u670D\u52A1\u8BF7\u6C42\u8D85\u65F6\u3002", { cause: error });
    }
    if (error instanceof WeixinApiError) throw error;
    throw new WeixinApiError("network-error", "\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\u5FAE\u4FE1\u670D\u52A1\u3002", { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
function validateLoginResponse(value) {
  if (!value || typeof value !== "object" || !LOGIN_STATUSES.has(value.status)) {
    throw new WeixinApiError("invalid-login-status", "\u5FAE\u4FE1\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u626B\u7801\u72B6\u6001\u3002");
  }
  return value;
}
function createWeixinApi({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  return Object.freeze({
    async beginLogin({ localTokens = [], botType = DEFAULT_BOT_TYPE, signal } = {}) {
      const tokens = [...new Set(localTokens.map(nonEmptyString).filter(Boolean))].slice(-10);
      const response = await requestJson(fetchImpl, {
        method: "POST",
        baseUrl: WEIXIN_QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: tokens },
        timeoutMs: 1e4,
        signal
      });
      const qrcode = nonEmptyString(response?.qrcode);
      if (!qrcode) throw new WeixinApiError("invalid-qr", "\u5FAE\u4FE1\u670D\u52A1\u6CA1\u6709\u8FD4\u56DE\u4E8C\u7EF4\u7801\u4EE4\u724C\u3002");
      return {
        qrcode,
        qrcodeUrl: normalizeWeixinQrUrl(response.qrcode_img_content)
      };
    },
    async pollLogin({ qrcode, baseUrl = WEIXIN_QR_BASE_URL, verifyCode, signal }) {
      const qr = nonEmptyString(qrcode);
      if (!qr) throw new TypeError("qrcode is required");
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`;
      if (nonEmptyString(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`;
      const response = await requestJson(fetchImpl, {
        method: "GET",
        baseUrl,
        endpoint,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        signal,
        authenticated: false
      });
      return validateLoginResponse(response);
    },
    async getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs, signal }) {
      try {
        return await requestJson(fetchImpl, {
          method: "POST",
          baseUrl,
          endpoint: "ilink/bot/getupdates",
          body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
          token,
          timeoutMs: timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
          signal
        });
      } catch (error) {
        if (error instanceof WeixinApiError && error.code === "timeout") {
          return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
        }
        throw error;
      }
    },
    async sendText({ baseUrl, token, toUserId, text, contextToken, runId, signal }) {
      const recipient = nonEmptyString(toUserId);
      const content = nonEmptyString(text);
      if (!recipient || !content) throw new TypeError("toUserId and text are required");
      const response = await requestJson(fetchImpl, {
        method: "POST",
        baseUrl,
        endpoint: "ilink/bot/sendmessage",
        token,
        signal,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: recipient,
            client_id: `dsh-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: content } }],
            ...nonEmptyString(contextToken) ? { context_token: contextToken.trim() } : {},
            ...nonEmptyString(runId) ? { run_id: runId.trim() } : {}
          },
          base_info: baseInfo()
        }
      });
      if (response?.ret !== void 0 && response.ret !== 0) {
        throw new WeixinApiError("send-rejected", "\u5FAE\u4FE1\u670D\u52A1\u62D2\u7EDD\u4E86\u56DE\u590D\u6D88\u606F\u3002");
      }
      return true;
    },
    async notifyStart({ baseUrl, token, signal }) {
      const response = await requestJson(fetchImpl, {
        method: "POST",
        baseUrl,
        endpoint: "ilink/bot/msg/notifystart",
        token,
        signal,
        timeoutMs: 1e4,
        body: { base_info: baseInfo() }
      });
      if (response?.ret !== void 0 && response.ret !== 0) {
        throw new WeixinApiError("start-rejected", "\u5FAE\u4FE1\u8D26\u53F7\u8FDE\u63A5\u542F\u52A8\u5931\u8D25\u3002");
      }
      return response;
    },
    async notifyStop({ baseUrl, token, signal }) {
      return requestJson(fetchImpl, {
        method: "POST",
        baseUrl,
        endpoint: "ilink/bot/msg/notifystop",
        token,
        signal,
        timeoutMs: 1e4,
        body: { base_info: baseInfo() }
      });
    }
  });
}
function extractWeixinText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === "string") {
      const text = item.text_item.text.trim();
      if (text) return text;
    }
    if (item?.type === 3 && typeof item.voice_item?.text === "string") {
      const text = item.voice_item.text.trim();
      if (text) return text;
    }
  }
  return null;
}
function weixinMessageId(message) {
  if (message?.message_id !== void 0 && message.message_id !== null) {
    return String(message.message_id);
  }
  return nonEmptyString(message?.client_id);
}
function splitWeixinText(text, maxChars = 4e3) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// src/config-store.mjs
var EMPTY_DOCUMENT = Object.freeze({ version: 1, accounts: Object.freeze([]) });
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeBotId(value) {
  const id = cleanString(value);
  return id && /^wx_[a-f0-9]{24}$/.test(id) ? id : null;
}
function safeTokenRef(value) {
  const ref = cleanString(value);
  return ref && /^DSH_WEIXIN_BOT_TOKEN_[A-F0-9]{24}$/.test(ref) ? ref : null;
}
function deriveWeixinBotIdentity(accountId) {
  const raw = cleanString(accountId);
  if (!raw) throw new TypeError("accountId is required");
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return {
    botId: `wx_${digest}`,
    tokenRef: `DSH_WEIXIN_BOT_TOKEN_${digest.toUpperCase()}`
  };
}
function maskWeixinAccountId(accountId) {
  const value = cleanString(accountId) ?? "";
  if (value.length <= 10) return value ? `${value.slice(0, 3)}\u2022\u2022\u2022` : "\u5FAE\u4FE1\u673A\u5668\u4EBA";
  return `${value.slice(0, 6)}\u2022\u2022\u2022\u2022${value.slice(-4)}`;
}
function normalizeAccount(value) {
  if (!value || typeof value !== "object") return null;
  const accountId = cleanString(value.accountId);
  const ownerUserId = cleanString(value.ownerUserId);
  const botId = safeBotId(value.botId);
  const tokenRef = safeTokenRef(value.tokenRef);
  if (!accountId || !ownerUserId || !botId || !tokenRef) return null;
  const derived = deriveWeixinBotIdentity(accountId);
  if (derived.botId !== botId || derived.tokenRef !== tokenRef) return null;
  let baseUrl;
  try {
    baseUrl = normalizeWeixinApiBaseUrl(value.baseUrl);
  } catch {
    return null;
  }
  return Object.freeze({
    botId,
    accountId,
    tokenRef,
    ownerUserId,
    baseUrl,
    createdAt: cleanString(value.createdAt) ?? (/* @__PURE__ */ new Date()).toISOString(),
    connectedAt: cleanString(value.connectedAt)
  });
}
function normalizeDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.accounts)) return null;
  const accounts = value.accounts.map(normalizeAccount);
  if (accounts.some((account) => account === null)) return null;
  const ids = /* @__PURE__ */ new Set();
  const accountIds = /* @__PURE__ */ new Set();
  const refs = /* @__PURE__ */ new Set();
  for (const account of accounts) {
    if (ids.has(account.botId) || accountIds.has(account.accountId) || refs.has(account.tokenRef)) {
      return null;
    }
    ids.add(account.botId);
    accountIds.add(account.accountId);
    refs.add(account.tokenRef);
  }
  return Object.freeze({ version: 1, accounts: Object.freeze(accounts) });
}
var WeixinConfigStore = class {
  #path;
  #value = EMPTY_DOCUMENT;
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      const normalized = normalizeDocument(JSON.parse(await readFile(this.#path, "utf8")));
      if (!normalized) throw new Error("dsh-weixin config contains invalid account data");
      this.#value = normalized;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#value = EMPTY_DOCUMENT;
    }
    return this;
  }
  list() {
    return structuredClone(this.#value.accounts);
  }
  get(botId) {
    const account = this.#value.accounts.find((candidate) => candidate.botId === botId);
    return account ? structuredClone(account) : null;
  }
  getByAccountId(accountId) {
    const account = this.#value.accounts.find((candidate) => candidate.accountId === accountId);
    return account ? structuredClone(account) : null;
  }
  async save(value) {
    const normalized = normalizeAccount(value);
    if (!normalized) throw new Error("Refusing to persist incomplete dsh-weixin account data");
    return this.#mutate((accounts) => {
      const accountCollision = accounts.find(
        (account) => account.accountId === normalized.accountId && account.botId !== normalized.botId
      );
      const refCollision = accounts.find(
        (account) => account.tokenRef === normalized.tokenRef && account.botId !== normalized.botId
      );
      if (accountCollision || refCollision) throw new Error("Duplicate Weixin account identity");
      const index = accounts.findIndex((account) => account.botId === normalized.botId);
      if (index === -1) accounts.push(normalized);
      else accounts[index] = normalized;
      return structuredClone(normalized);
    });
  }
  async remove(botId) {
    if (!safeBotId(botId)) throw new TypeError("Invalid Weixin bot id");
    return this.#mutate((accounts) => {
      const index = accounts.findIndex((account) => account.botId === botId);
      if (index === -1) return null;
      const [removed] = accounts.splice(index, 1);
      return structuredClone(removed);
    });
  }
  async clear() {
    const operation = this.#writeQueue.then(async () => {
      try {
        await unlink(this.#path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      this.#value = EMPTY_DOCUMENT;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
  async #mutate(mutator) {
    let result;
    const operation = this.#writeQueue.then(async () => {
      const accounts = [...this.#value.accounts];
      result = mutator(accounts);
      const document = Object.freeze({ version: 1, accounts: Object.freeze(accounts) });
      await this.#write(document);
      this.#value = document;
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
    return result;
  }
  async #write(document) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 448 });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    await rename(temporary, this.#path);
  }
};

// src/harness-client.mjs
import { spawn } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
var sleep = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));
function assistantMessageText(event) {
  return (event?.data?.message?.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}
var HarnessReplyTracker = class {
  #promptRpcId;
  #lastSeq;
  #openTurn = null;
  #targetTurn = null;
  #stepText = /* @__PURE__ */ new Map();
  #latestText = "";
  #finished = false;
  #reason = null;
  constructor({ promptRpcId, afterSeq = -1 }) {
    this.#promptRpcId = promptRpcId;
    this.#lastSeq = afterSeq;
  }
  get finished() {
    return this.#finished;
  }
  get answer() {
    return this.#latestText.trim();
  }
  get reason() {
    return this.#reason;
  }
  consume(entries) {
    let update = null;
    const ordered = [...entries].map((entry) => entry?.event ?? entry).filter(Boolean).sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1));
    for (const event of ordered) {
      const seq = event.seq ?? -1;
      if (seq <= this.#lastSeq) continue;
      this.#lastSeq = seq;
      if (event.type === "turn/start") this.#openTurn = event.data?.turn ?? null;
      if (event.type === "user/message" && event.data?.source?.rpcId === this.#promptRpcId) {
        this.#targetTurn = this.#openTurn;
        continue;
      }
      if (this.#targetTurn === null) continue;
      if (event.type === "turn/end") {
        if (event.data?.turn !== this.#targetTurn) continue;
        this.#finished = true;
        this.#reason = event.data?.reason ?? null;
        this.#openTurn = null;
        continue;
      }
      if (event.data?.turn !== this.#targetTurn) continue;
      if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
        const step = event.data?.step ?? 0;
        const index = event.data.chunk.index ?? 0;
        const key = `${step}:${index}`;
        this.#stepText.set(key, (this.#stepText.get(key) ?? "") + event.data.chunk.text);
        const prefix = `${step}:`;
        const text = [...this.#stepText.entries()].filter(([partKey]) => partKey.startsWith(prefix)).sort(([left], [right]) => Number(left.split(":")[1]) - Number(right.split(":")[1])).map(([, part]) => part).join("\n").trim();
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "assistant/message") {
        const text = assistantMessageText(event);
        if (text && text !== this.#latestText) {
          this.#latestText = text;
          update = { type: "text", text };
        }
        continue;
      }
      if (event.type === "tool/call") {
        update = { type: "tool", name: event.data?.name ?? "\u5DE5\u5177" };
      } else if (event.type === "tool/result") {
        update = { type: "status", text: "\u6B63\u5728\u6574\u7406\u7ED3\u679C\u2026" };
      }
    }
    return update;
  }
};
var HarnessRpcError = class extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? "unknown Harness RPC error"}`);
    this.name = "HarnessRpcError";
    this.method = method;
    this.code = error?.code ?? "internal";
    this.details = error?.details ?? {};
  }
};
var HarnessClient = class {
  #baseUrl;
  #workspace;
  #agentPreset;
  #autostart;
  #dshBin;
  #managedProcess = null;
  #onSessionCreated = null;
  constructor({ baseUrl, workspace, agentPreset = "standard", autostart = false, dshBin = "dsh", onSessionCreated = null }) {
    this.#baseUrl = new URL(baseUrl);
    this.#workspace = workspace;
    this.#agentPreset = agentPreset;
    this.#autostart = autostart;
    this.#dshBin = dshBin;
    this.#onSessionCreated = onSessionCreated;
  }
  async rpc(method, payload = {}, timeoutMs = 3e4, options = {}) {
    const rpcId = options.rpcId ?? `weixin-${randomUUID2()}`;
    const response = await fetch(new URL(`/api/${method}`, this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Harness transport ${method} failed: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.type !== "server-response" || body?.rpcId !== rpcId) {
      throw new Error(`Harness returned an invalid response for ${method}`);
    }
    if (!body.result?.ok) throw new HarnessRpcError(method, body.result?.error);
    return body.result.value;
  }
  async health() {
    await this.rpc("host.describe", {}, 5e3);
    return true;
  }
  async ensureRunning() {
    try {
      return await this.health();
    } catch (firstError) {
      if (!this.#autostart) throw firstError;
    }
    if (!this.#managedProcess || this.#managedProcess.exitCode !== null) {
      const port = this.#baseUrl.port || (this.#baseUrl.protocol === "https:" ? "443" : "80");
      this.#managedProcess = spawn(this.#dshBin, [
        "web",
        "--host",
        this.#baseUrl.hostname,
        "--port",
        port
      ], {
        cwd: this.#workspace,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"]
      });
      this.#managedProcess.on("error", (error) => {
        console.error("[dsh-weixin] failed to start Harness:", error.message);
      });
    }
    const deadline = Date.now() + 6e4;
    let lastError;
    while (Date.now() < deadline) {
      await sleep(1e3);
      try {
        return await this.health();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Harness did not become ready: ${lastError?.message ?? "timeout"}`);
  }
  async workspaceId() {
    const { items } = await this.rpc("workspace.list", {});
    const existing = items.find((item) => item.path === this.#workspace);
    if (existing) return existing.workspaceId;
    const created = await this.rpc("workspace.create", { path: this.#workspace });
    return created.workspace.workspaceId;
  }
  async createSession() {
    await this.ensureRunning();
    const workspaceId = await this.workspaceId();
    const created = await this.rpc("session.create", {
      workspaceId,
      agentPreset: this.#agentPreset
    });
    await this.#onSessionCreated?.(created.sessionId);
    return created.sessionId;
  }
  async sessionExists(sessionId) {
    try {
      await this.rpc("session.history", { sessionId, maxMessages: 1 });
      return true;
    } catch (error) {
      if (error instanceof HarnessRpcError && error.code === "session-not-found") return false;
      throw error;
    }
  }
  async ask(sessionId, text, options = {}) {
    if (typeof options === "number") options = { timeoutMs: options };
    const timeoutMs = options.timeoutMs ?? 6e5;
    const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;
    await this.ensureRunning();
    const before = await this.rpc("session.history", { sessionId, maxMessages: 1 });
    const baselineSeq = Math.max(-1, ...(before.events ?? []).map(({ event }) => event.seq ?? -1));
    const promptRpcId = `weixin-${randomUUID2()}`;
    const tracker = new HarnessReplyTracker({ promptRpcId, afterSeq: baselineSeq });
    await this.rpc("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }, 3e4, { rpcId: promptRpcId });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      const history = await this.rpc("session.history", { sessionId, maxMessages: 50 });
      const update = tracker.consume(history.events ?? []);
      if (update && onUpdate) {
        try {
          await onUpdate(update);
        } catch (error) {
          console.warn("[dsh-weixin] ignored a progress update failure:", error.message);
        }
      }
      if (!tracker.finished) continue;
      if (tracker.answer) return tracker.answer;
      throw new Error(
        `Harness turn ended without a text reply${tracker.reason ? ` (${JSON.stringify(tracker.reason)})` : ""}`
      );
    }
    throw new Error(`Harness reply timed out after ${Math.round(timeoutMs / 1e3)} seconds`);
  }
  stopManagedProcess() {
    if (this.#managedProcess?.exitCode === null) this.#managedProcess.kill("SIGTERM");
  }
};

// src/state-store.mjs
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, unlink as unlink2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
var EMPTY_STATE = Object.freeze({
  version: 1,
  sessions: {},
  seenMessageIds: [],
  getUpdatesBuf: ""
});
function normalizeState(value) {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === "string" && typeof sessionId === "string" && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  return {
    version: 1,
    sessions,
    seenMessageIds: Array.isArray(value.seenMessageIds) ? value.seenMessageIds.filter((id) => typeof id === "string").slice(-1e3) : [],
    getUpdatesBuf: typeof value.getUpdatesBuf === "string" ? value.getUpdatesBuf : ""
  };
}
var WeixinStateStore = class {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();
  constructor(path) {
    this.#path = path;
  }
  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile2(this.#path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }
  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }
  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }
  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }
  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }
  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1e3) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1e3);
    }
    await this.#persist();
  }
  getUpdatesBuf() {
    return this.#state.getUpdatesBuf;
  }
  async setGetUpdatesBuf(value) {
    if (typeof value !== "string" || value === this.#state.getUpdatesBuf) return;
    this.#state.getUpdatesBuf = value;
    await this.#persist();
  }
  snapshot() {
    return structuredClone(this.#state);
  }
  async remove() {
    try {
      await unlink2(this.#path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#state = structuredClone(EMPTY_STATE);
  }
  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}
`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir2(dirname2(this.#path), { recursive: true, mode: 448 });
      const temporary = `${this.#path}.tmp`;
      await writeFile2(temporary, snapshot, { encoding: "utf8", mode: 384 });
      await rename2(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => void 0, () => void 0);
    await operation;
  }
};

// src/weixin-controller.mjs
import { randomUUID as randomUUID3 } from "node:crypto";
var ACTIVE_ATTEMPT_STATES = /* @__PURE__ */ new Set([
  "starting",
  "pending",
  "scanned",
  "needs_verification",
  "connecting"
]);
var TERMINAL_ATTEMPT_STATES = /* @__PURE__ */ new Set(["connected", "expired", "failed", "cancelled"]);
var QR_TTL_MS = 5 * 6e4;
function cleanString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function abortError2() {
  return new DOMException("Provisioning was cancelled", "AbortError");
}
function apiBaseFromServer(value, fallback) {
  const raw = cleanString2(value);
  if (!raw) return normalizeWeixinApiBaseUrl(fallback);
  return normalizeWeixinApiBaseUrl(raw.includes("://") ? raw : `https://${raw}`);
}
function publicAttempt(record) {
  if (!record) return null;
  return {
    attemptId: record.id,
    status: record.state,
    ...record.verificationUrl ? { verificationUrl: record.verificationUrl } : {},
    ...record.expiresAt ? { expiresAt: record.expiresAt } : {},
    pollIntervalMs: 1e3,
    ...record.state === "needs_verification" ? { verificationRequired: true } : {},
    ...record.botId ? { botId: record.botId } : {},
    ...record.alreadyConnected ? { alreadyConnected: true } : {},
    ...record.error ? { error: structuredClone(record.error) } : {}
  };
}
function safeAccountError(code, message) {
  return Object.freeze({ code, message });
}
var WeixinController = class {
  #api;
  #credentials;
  #configStore;
  #createRuntime;
  #deleteState;
  #logger;
  #runtimes = /* @__PURE__ */ new Map();
  #errors = /* @__PURE__ */ new Map();
  #attempts = /* @__PURE__ */ new Map();
  #activeAttemptId = null;
  #transitions = /* @__PURE__ */ new Map();
  #revision = 0;
  #closed = false;
  constructor({
    api,
    credentials,
    configStore,
    createRuntime,
    deleteState = async () => {
    },
    logger = console
  }) {
    if (!api || typeof api.beginLogin !== "function" || typeof api.pollLogin !== "function") {
      throw new TypeError("WeixinController requires a Weixin API client");
    }
    if (!credentials || typeof credentials.resolve !== "function" || typeof credentials.set !== "function" || typeof credentials.unset !== "function") {
      throw new TypeError("WeixinController requires the DSH credential provider");
    }
    if (!configStore || typeof configStore.list !== "function" || typeof configStore.save !== "function" || typeof configStore.remove !== "function") {
      throw new TypeError("WeixinController requires a config store");
    }
    if (typeof createRuntime !== "function") throw new TypeError("createRuntime is required");
    this.#api = api;
    this.#credentials = credentials;
    this.#configStore = configStore;
    this.#createRuntime = createRuntime;
    this.#deleteState = deleteState;
    this.#logger = logger;
  }
  async initialize() {
    if (this.#closed) return this.status();
    for (const config of this.#configStore.list()) {
      const current = this.#runtimes.get(config.botId);
      if (current?.status?.ready === true) continue;
      await this.#withBotTransition(config.botId, async () => {
        const latest = this.#configStore.get(config.botId);
        if (!latest || this.#closed) return;
        try {
          const token = await this.#resolveToken(latest.tokenRef);
          if (!token) {
            this.#errors.set(
              latest.botId,
              safeAccountError("missing-token", "\u767B\u5F55\u51ED\u636E\u7F3A\u5931\uFF0C\u8BF7\u79FB\u9664\u8D26\u53F7\u540E\u91CD\u65B0\u626B\u7801\u3002")
            );
            return;
          }
          await this.#startRuntime(latest, token);
          this.#errors.delete(latest.botId);
        } catch (error) {
          this.#errors.set(
            latest.botId,
            safeAccountError("connection-failed", "\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002")
          );
          this.#logger.warn?.(`[dsh-weixin] account ${latest.botId} failed to initialize:`, error);
        } finally {
          this.#touch();
        }
      });
    }
    return this.status();
  }
  /** The running bridge that owns the given harness session, or null. */
  bridgeForSession(sessionId) {
    for (const runtime of this.#runtimes.values()) {
      const bridge = runtime.bridge;
      if (bridge && bridge.ownsSession(sessionId)) return bridge;
    }
    return null;
  }
  async startProvisioning() {
    if (this.#closed) throw new Error("dsh-weixin controller is closed");
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    const record = {
      id: randomUUID3(),
      state: "starting",
      createdAt: Date.now(),
      expiresAt: Date.now() + QR_TTL_MS,
      controller: new AbortController(),
      pendingVerifyCode: null,
      verifyResolve: null,
      currentBaseUrl: WEIXIN_QR_BASE_URL,
      error: null,
      botId: null,
      task: null
    };
    this.#attempts.set(record.id, record);
    this.#activeAttemptId = record.id;
    this.#touch();
    try {
      const localTokens = (await Promise.all(
        this.#configStore.list().slice(-10).map(async (config) => this.#resolveToken(config.tokenRef))
      )).filter(Boolean);
      const login = await this.#api.beginLogin({
        localTokens,
        signal: record.controller.signal
      });
      this.#assertAttemptActive(record);
      record.qrcode = login.qrcode;
      record.verificationUrl = login.qrcodeUrl;
      record.state = "pending";
      record.expiresAt = Date.now() + QR_TTL_MS;
      this.#touch();
      record.task = this.#runProvisioning(record);
      return publicAttempt(record);
    } catch (error) {
      if (record.controller.signal.aborted) {
        record.state = "cancelled";
        record.error = safeAccountError("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      } else {
        record.state = "failed";
        record.error = safeAccountError(
          error instanceof WeixinApiError ? error.code : "qr-start-failed",
          error instanceof WeixinApiError ? error.message : "\u65E0\u6CD5\u751F\u6210\u5FAE\u4FE1\u4E8C\u7EF4\u7801\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
        );
      }
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
      throw error;
    }
  }
  registrationStatus(attemptId) {
    return publicAttempt(this.#attempts.get(attemptId));
  }
  async submitVerification(attemptId, verifyCode) {
    const record = this.#attempts.get(attemptId);
    if (!record || record.state !== "needs_verification") {
      throw new Error("The provisioning attempt is not waiting for a verification code");
    }
    const code = cleanString2(verifyCode);
    if (!code || !/^\d{4,8}$/.test(code)) {
      throw new TypeError("Verification code must contain 4 to 8 digits");
    }
    record.pendingVerifyCode = code;
    record.state = "scanned";
    record.verifyResolve?.();
    record.verifyResolve = null;
    this.#touch();
    return publicAttempt(record);
  }
  async cancelProvisioning(attemptId) {
    const record = this.#attempts.get(attemptId);
    if (!record) return null;
    if (!TERMINAL_ATTEMPT_STATES.has(record.state)) {
      record.controller.abort();
      record.verifyResolve?.();
      record.verifyResolve = null;
      await record.task?.catch(() => void 0);
      if (!TERMINAL_ATTEMPT_STATES.has(record.state)) record.state = "cancelled";
      record.error ??= safeAccountError("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
    }
    if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
    this.#touch();
    return publicAttempt(record);
  }
  async reconnectBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown Weixin account");
    await this.#withBotTransition(botId, async () => {
      const token = await this.#resolveToken(config.tokenRef);
      if (!token) throw new Error("The Weixin token is missing");
      try {
        await this.#startRuntime(config, token);
        this.#errors.delete(botId);
      } catch (error) {
        this.#errors.set(botId, safeAccountError("connection-failed", "\u5FAE\u4FE1\u8FDE\u63A5\u4ECD\u672A\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"));
        throw error;
      } finally {
        this.#touch();
      }
    });
    return this.status();
  }
  async deleteBot(botId) {
    const config = this.#configStore.get(botId);
    if (!config) throw new Error("Unknown Weixin account");
    await this.#withBotTransition(botId, async () => {
      const previousToken = await this.#credentials.resolve(config.tokenRef).catch(() => void 0);
      await this.#stopRuntime(botId);
      try {
        await this.#credentials.unset(config.tokenRef);
        await this.#configStore.remove(botId);
      } catch (error) {
        if (previousToken?.value) {
          await this.#credentials.set(config.tokenRef, previousToken.value).catch(() => void 0);
          await this.#startRuntime(config, previousToken.value).catch(() => void 0);
        }
        throw new Error("Unable to remove the Weixin account safely.", { cause: error });
      }
      try {
        await this.#deleteState({ botId, config });
      } catch (error) {
        this.#logger.warn?.(`[dsh-weixin] account ${botId} state cleanup failed:`, error);
      }
      this.#errors.delete(botId);
      this.#touch();
    });
    return this.status();
  }
  status() {
    const accounts = this.#configStore.list().map((config) => {
      const runtimeStatus = this.#runtimes.get(config.botId)?.status ?? null;
      const connected = runtimeStatus?.ready === true && runtimeStatus.weixinConnectionState === "connected" && runtimeStatus.harnessReachable === true;
      const state = connected ? "connected" : runtimeStatus?.weixinConnectionState === "connecting" ? "connecting" : this.#errors.has(config.botId) || runtimeStatus?.weixinConnectionState === "failed" ? "error" : "offline";
      const error = this.#errors.get(config.botId) ?? (state === "error" ? safeAccountError("connection-failed", "\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002") : null);
      return {
        botId: config.botId,
        state,
        connected,
        configured: true,
        bot: {
          name: "\u5FAE\u4FE1\u673A\u5668\u4EBA",
          accountIdMasked: maskWeixinAccountId(config.accountId)
        },
        health: {
          status: connected ? "healthy" : state === "error" ? "error" : "offline",
          summary: connected ? "\u5FAE\u4FE1\u6D88\u606F\u957F\u8F6E\u8BE2\u8FD0\u884C\u6B63\u5E38" : state === "error" ? "\u5FAE\u4FE1\u8FDE\u63A5\u672A\u5C31\u7EEA\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u91CD\u8BD5" : "\u5FAE\u4FE1\u8FDE\u63A5\u5F53\u524D\u79BB\u7EBF",
          lastCheckedAt: runtimeStatus?.lastCheckedAt ?? null
        },
        stats: {
          messagesReceived: runtimeStatus?.messagesReceived ?? 0,
          messagesReplied: runtimeStatus?.messagesReplied ?? 0
        },
        error: error ? structuredClone(error) : null
      };
    });
    const connectedCount = accounts.filter((account) => account.connected).length;
    const active = this.#activeAttemptId ? this.#attempts.get(this.#activeAttemptId) : null;
    return {
      schemaVersion: 1,
      revision: this.#revision,
      state: active && ACTIVE_ATTEMPT_STATES.has(active.state) ? "provisioning" : accounts.length === 0 ? "disconnected" : connectedCount === accounts.length ? "connected" : connectedCount > 0 ? "degraded" : "offline",
      bots: accounts,
      totals: { configured: accounts.length, connected: connectedCount },
      ...active && ACTIVE_ATTEMPT_STATES.has(active.state) ? { provisioning: publicAttempt(active) } : {}
    };
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeAttemptId) await this.cancelProvisioning(this.#activeAttemptId);
    await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
  }
  async #runProvisioning(record) {
    try {
      while (!record.controller.signal.aborted && Date.now() < record.expiresAt) {
        if (record.state === "needs_verification" && !record.pendingVerifyCode) {
          await new Promise((resolve2) => {
            record.verifyResolve = resolve2;
            if (record.controller.signal.aborted) resolve2();
          });
          record.verifyResolve = null;
          this.#assertAttemptActive(record);
        }
        const response = await this.#api.pollLogin({
          qrcode: record.qrcode,
          baseUrl: record.currentBaseUrl,
          verifyCode: record.pendingVerifyCode,
          signal: record.controller.signal
        });
        this.#assertAttemptActive(record);
        if (response.status === "wait") {
          record.state = "pending";
        } else if (response.status === "scaned") {
          record.pendingVerifyCode = null;
          record.state = "scanned";
        } else if (response.status === "need_verifycode") {
          record.pendingVerifyCode = null;
          record.state = "needs_verification";
        } else if (response.status === "verify_code_blocked") {
          record.state = "failed";
          record.error = safeAccountError("verification-blocked", "\u914D\u5BF9\u7801\u591A\u6B21\u9519\u8BEF\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u4E8C\u7EF4\u7801\u3002");
          break;
        } else if (response.status === "expired") {
          record.state = "expired";
          record.error = safeAccountError("expired", "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
          break;
        } else if (response.status === "scaned_but_redirect") {
          record.currentBaseUrl = apiBaseFromServer(response.redirect_host, record.currentBaseUrl);
          record.state = "scanned";
        } else if (response.status === "binded_redirect") {
          const existing = this.#configStore.list().find(
            (config) => this.#runtimes.get(config.botId)?.status?.ready === true
          ) ?? this.#configStore.list()[0];
          if (!existing) {
            record.state = "failed";
            record.error = safeAccountError("already-bound", "\u8BE5\u5FAE\u4FE1\u8D26\u53F7\u5DF2\u7ED1\u5B9A\uFF0C\u4F46\u672C\u673A\u6CA1\u6709\u53EF\u6062\u590D\u7684\u51ED\u636E\u3002");
          } else {
            record.state = "connected";
            record.botId = existing.botId;
            record.alreadyConnected = true;
          }
          break;
        } else if (response.status === "confirmed") {
          const token = cleanString2(response.bot_token);
          const accountId = cleanString2(response.ilink_bot_id);
          const ownerUserId = cleanString2(response.ilink_user_id);
          if (!token || !accountId || !ownerUserId) {
            throw new WeixinApiError("incomplete-login", "\u5FAE\u4FE1\u6388\u6743\u6210\u529F\uFF0C\u4F46\u8FD4\u56DE\u7684\u8D26\u53F7\u51ED\u636E\u4E0D\u5B8C\u6574\u3002");
          }
          record.state = "connecting";
          this.#touch();
          const baseUrl = apiBaseFromServer(response.baseurl, record.currentBaseUrl);
          record.botId = await this.#activateAccount(record, {
            token,
            accountId,
            ownerUserId,
            baseUrl
          });
          record.state = "connected";
          record.error = null;
          break;
        }
        this.#touch();
      }
      if (!record.controller.signal.aborted && Date.now() >= record.expiresAt && !TERMINAL_ATTEMPT_STATES.has(record.state)) {
        record.state = "expired";
        record.error = safeAccountError("expired", "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u3002");
      }
    } catch (error) {
      if (record.controller.signal.aborted || error?.name === "AbortError") {
        record.state = "cancelled";
        record.error = safeAccountError("cancelled", "\u626B\u7801\u7ED1\u5B9A\u5DF2\u53D6\u6D88\u3002");
      } else {
        record.state = "failed";
        record.error = safeAccountError(
          error instanceof WeixinApiError ? error.code : "activation-failed",
          error instanceof WeixinApiError ? error.message : "\u5FAE\u4FE1\u5DF2\u6388\u6743\uFF0C\u4F46\u65E0\u6CD5\u4FDD\u5B58\u51ED\u636E\u6216\u542F\u52A8\u6D88\u606F\u8FDE\u63A5\u3002"
        );
        this.#logger.error?.("[dsh-weixin] provisioning failed:", error);
      }
    } finally {
      record.pendingVerifyCode = null;
      record.verifyResolve?.();
      record.verifyResolve = null;
      if (this.#activeAttemptId === record.id) this.#activeAttemptId = null;
      this.#touch();
      this.#pruneAttempts();
    }
  }
  async #activateAccount(record, { token, accountId, ownerUserId, baseUrl }) {
    const identity = deriveWeixinBotIdentity(accountId);
    const previousConfig = this.#configStore.getByAccountId(accountId);
    const config = {
      botId: identity.botId,
      accountId,
      tokenRef: identity.tokenRef,
      ownerUserId,
      baseUrl,
      createdAt: previousConfig?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      connectedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const previousToken = await this.#credentials.resolve(identity.tokenRef).catch(() => void 0);
    return this.#withBotTransition(identity.botId, async () => {
      await this.#credentials.set(identity.tokenRef, token);
      try {
        this.#assertAttemptActive(record);
        await this.#configStore.save(config);
        this.#assertAttemptActive(record);
        await this.#startRuntime(config, token);
        this.#assertAttemptActive(record);
        this.#errors.delete(identity.botId);
        this.#touch();
        return identity.botId;
      } catch (error) {
        await this.#stopRuntime(identity.botId);
        if (previousConfig) await this.#configStore.save(previousConfig).catch(() => void 0);
        else if (this.#configStore.get(identity.botId)) {
          await this.#configStore.remove(identity.botId).catch(() => void 0);
        }
        await this.#restoreCredential(identity.tokenRef, previousToken);
        if (previousConfig && previousToken?.value) {
          await this.#startRuntime(previousConfig, previousToken.value).catch(() => void 0);
        }
        throw error;
      }
    });
  }
  async #startRuntime(config, token) {
    await this.#stopRuntime(config.botId);
    const runtime = await this.#createRuntime({ botId: config.botId, config, token });
    if (!runtime || typeof runtime.start !== "function" || typeof runtime.stop !== "function") {
      throw new TypeError("createRuntime returned an invalid Weixin runtime");
    }
    try {
      await runtime.start();
      this.#runtimes.set(config.botId, runtime);
    } catch (error) {
      await runtime.stop().catch(() => void 0);
      throw error;
    }
  }
  async #stopRuntime(botId) {
    const runtime = this.#runtimes.get(botId);
    this.#runtimes.delete(botId);
    await runtime?.stop().catch((error) => {
      this.#logger.warn?.(`[dsh-weixin] account ${botId} failed to stop cleanly:`, error);
    });
  }
  async #resolveToken(ref) {
    const result = await this.#credentials.resolve(ref).catch(() => void 0);
    return cleanString2(result?.value);
  }
  async #restoreCredential(ref, previous) {
    try {
      if (previous?.value) await this.#credentials.set(ref, previous.value);
      else await this.#credentials.unset(ref);
    } catch (error) {
      this.#logger.error?.(`[dsh-weixin] failed to restore credential ${ref}:`, error);
    }
  }
  #assertAttemptActive(record) {
    if (record.controller.signal.aborted || this.#activeAttemptId !== record.id) throw abortError2();
  }
  #withBotTransition(botId, operation) {
    const previous = this.#transitions.get(botId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(operation);
    const settled = current.finally(() => {
      if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
    });
    this.#transitions.set(botId, settled);
    return settled;
  }
  #pruneAttempts() {
    for (const [id, record] of this.#attempts) {
      if (id !== this.#activeAttemptId && TERMINAL_ATTEMPT_STATES.has(record.state) && this.#attempts.size > 16) {
        this.#attempts.delete(id);
      }
    }
  }
  #touch() {
    this.#revision += 1;
  }
};

// src/weixin-bridge.mjs
var HELP_TEXT = [
  "\u5FAE\u4FE1\u5DF2\u8FDE\u63A5 DeepSeek Harness\u3002",
  "",
  "\u76F4\u63A5\u53D1\u9001\u6587\u5B57\u6216\u5E26\u6587\u5B57\u8BC6\u522B\u7ED3\u679C\u7684\u8BED\u97F3\u5373\u53EF\u7EE7\u7EED\u5F53\u524D\u4F1A\u8BDD\u3002",
  "/new  \u5F00\u542F\u4E00\u4E2A\u5168\u65B0\u4F1A\u8BDD",
  "/status  \u68C0\u67E5\u8FDE\u63A5\u72B6\u6001",
  "/help  \u663E\u793A\u672C\u5E2E\u52A9"
].join("\n");
function conversationKey(userId) {
  return `p2p:${userId}`;
}
var ALLOW_WORDS = /* @__PURE__ */ new Set(["\u5141\u8BB8", "\u540C\u610F", "\u6279\u51C6", "\u7EE7\u7EED", "\u662F", "\u597D", "ok", "yes", "allow", "y", "1"]);
var DENY_WORDS = /* @__PURE__ */ new Set(["\u62D2\u7EDD", "\u53D6\u6D88", "\u7981\u6B62", "\u5426", "\u4E0D", "no", "deny", "stop", "n", "0"]);
function parseApprovalAnswer(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (ALLOW_WORDS.has(normalized)) return true;
  if (DENY_WORDS.has(normalized)) return false;
  return null;
}
function createWeixinBridgeStatus() {
  return {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesRejected: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastRejectedAt: null,
    lastError: null
  };
}
var WeixinHarnessBridge = class {
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
  #queues = /* @__PURE__ */ new Map();
  #pendingApprovals = /* @__PURE__ */ new Map();
  constructor({
    api,
    baseUrl,
    token,
    ownerUserId,
    harness,
    state,
    status = createWeixinBridgeStatus(),
    logger = console,
    replyTimeoutMs = 6e5,
    maxMessageChars = 4e3,
    approvalTimeoutMs = 3e5
  }) {
    if (!api || typeof api.sendText !== "function") throw new TypeError("Weixin API is required");
    if (!baseUrl || !token || !ownerUserId) throw new TypeError("Weixin account credentials are required");
    if (!harness || !state) throw new TypeError("Harness client and state store are required");
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
  }
  get status() {
    return structuredClone(this.#status);
  }
  accept(message) {
    const sender = typeof message?.from_user_id === "string" ? message.from_user_id : "";
    const previous = this.#queues.get(sender) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(() => this.#process(message)).finally(() => {
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
      onAbort: null
    };
    const pending = new Promise((resolve2) => {
      entry.resolve = resolve2;
    });
    queue.push(entry);
    this.#pendingApprovals.set(userId, queue);
    if (req.signal) {
      if (req.signal.aborted) {
        this.#settle(entry, "cancelled");
        return pending;
      }
      entry.onAbort = () => this.#settle(entry, "cancelled");
      req.signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    entry.timer = setTimeout(() => this.#settle(entry, "rejected"), this.#approvalTimeoutMs);
    const lines = [`\u{1F512} \u9700\u8981\u4F60\u6279\u51C6\uFF1A${req.toolName}`];
    if (req.reason) lines.push(`\u539F\u56E0\uFF1A${req.reason}`);
    if (queue.length > 1) lines.push(`\uFF08\u7B2C ${entry.serial}/${queue.length} \u4E2A\u5F85\u6279\u51C6\u8BF7\u6C42\uFF09`);
    lines.push("\u56DE\u590D\u300C\u5141\u8BB8\u300D\u7EE7\u7EED\uFF0C\u6216\u300C\u62D2\u7EDD\u300D\u53D6\u6D88\u3002");
    try {
      await this.#send(userId, lines.join("\n"), void 0, void 0);
    } catch (error) {
      this.#logger.warn?.("[dsh-weixin] failed to send an approval question:", error);
    }
    return pending;
  }
  #settle(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    if (entry.req.signal && entry.onAbort) {
      entry.req.signal.removeEventListener("abort", entry.onAbort);
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
    const sender = typeof message?.from_user_id === "string" ? message.from_user_id : "";
    if (!messageId || !sender) return;
    if (this.#state.hasSeen(messageId)) return;
    this.#status.messagesReceived += 1;
    this.#status.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
    if (sender !== this.#ownerUserId) {
      this.#status.messagesRejected += 1;
      this.#status.lastRejectedAt = (/* @__PURE__ */ new Date()).toISOString();
      return;
    }
    const contextToken = typeof message.context_token === "string" ? message.context_token : void 0;
    const runId = typeof message.run_id === "string" ? message.run_id : void 0;
    const text = extractWeixinText(message);
    try {
      if (!text) {
        await this.#send(sender, "\u76EE\u524D\u4EC5\u652F\u6301\u6587\u5B57\u6D88\u606F\uFF0C\u4EE5\u53CA\u5FAE\u4FE1\u5DF2\u8F6C\u6210\u6587\u5B57\u7684\u8BED\u97F3\u6D88\u606F\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      const pending = this.#pendingApprovals.get(sender);
      if (pending && pending.length > 0) {
        const decision = parseApprovalAnswer(text);
        if (decision !== null) {
          const entry = pending[0];
          const outcome = decision ? "allowed-once" : "rejected";
          await this.#send(sender, decision ? "\u2705 \u5DF2\u5141\u8BB8\u3002" : "\u{1F6AB} \u5DF2\u62D2\u7EDD\u3002", contextToken, runId);
          await this.#state.markSeen(messageId);
          this.#settle(entry, outcome);
          return;
        }
        await this.#send(sender, `\u5F53\u524D\u6709 ${pending.length} \u4E2A\u5F85\u6279\u51C6\u8BF7\u6C42\uFF0C\u8BF7\u56DE\u590D\u300C\u5141\u8BB8\u300D\u6216\u300C\u62D2\u7EDD\u300D\u3002`, contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      const command = text.trim().toLowerCase();
      if (command === "/help") {
        await this.#send(sender, HELP_TEXT, contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === "/status") {
        await this.#harness.ensureRunning();
        await this.#send(sender, "\u5FAE\u4FE1\u4E0E DeepSeek Harness \u8FDE\u63A5\u6B63\u5E38\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      if (command === "/new") {
        await this.#state.clearSession(conversationKey(sender));
        await this.#send(sender, "\u5DF2\u5F00\u542F\u65B0\u4F1A\u8BDD\u3002\u8BF7\u53D1\u9001\u4F60\u7684\u95EE\u9898\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
        return;
      }
      const key = conversationKey(sender);
      let sessionId = this.#state.sessionFor(key);
      if (!sessionId || !await this.#harness.sessionExists(sessionId)) {
        sessionId = await this.#harness.createSession();
        await this.#state.setSession(key, sessionId);
      }
      const answer = await this.#harness.ask(sessionId, text, {
        timeoutMs: this.#replyTimeoutMs,
        onUpdate: async (update) => {
          if (update?.type === "tool" && typeof update.name === "string") {
            await this.#send(sender, `\u{1F527} \u6B63\u5728\u8C03\u7528\u5DE5\u5177\uFF1A${update.name}`, contextToken, runId);
          } else if (update?.type === "status" && typeof update.text === "string") {
            await this.#send(sender, `\u23F3 ${update.text}`, contextToken, runId);
          }
        }
      });
      await this.#send(sender, answer, contextToken, runId);
      await this.#state.markSeen(messageId);
      this.#status.messagesReplied += 1;
      this.#status.lastReplyAt = (/* @__PURE__ */ new Date()).toISOString();
      this.#status.lastError = null;
    } catch (error) {
      this.#status.lastError = error?.message ?? String(error);
      this.#logger.error?.("[dsh-weixin] failed to process an inbound message:", error);
      try {
        await this.#send(sender, "\u6D88\u606F\u5904\u7406\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", contextToken, runId);
        await this.#state.markSeen(messageId);
      } catch (sendError) {
        this.#logger.error?.("[dsh-weixin] failed to send the safe error reply:", sendError);
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
        runId
      });
    }
  }
};

// src/weixin-runtime.mjs
function delay(ms, signal) {
  return new Promise((resolve2, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve2();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function createWeixinRuntimeStatus() {
  return {
    startedAt: null,
    ready: false,
    weixinConnectionState: "idle",
    harnessReachable: false,
    lastCheckedAt: null,
    lastError: null,
    ...createWeixinBridgeStatus()
  };
}
var WeixinRuntime = class {
  #api;
  #config;
  #token;
  #harness;
  #state;
  #logger;
  #replyTimeoutMs;
  #maxMessageChars;
  #approvalTimeoutMs;
  #status = createWeixinRuntimeStatus();
  #bridge = null;
  #abortController = null;
  #monitor = null;
  #starting = null;
  constructor({
    api,
    config,
    token,
    harness,
    state,
    logger = console,
    replyTimeoutMs = 6e5,
    maxMessageChars = 4e3,
    approvalTimeoutMs = 3e5
  }) {
    if (!api || !config || !token || !harness || !state) {
      throw new TypeError("WeixinRuntime requires API, account, token, Harness, and state");
    }
    this.#api = api;
    this.#config = config;
    this.#token = token;
    this.#harness = harness;
    this.#state = state;
    this.#logger = logger;
    this.#replyTimeoutMs = replyTimeoutMs;
    this.#maxMessageChars = maxMessageChars;
    this.#approvalTimeoutMs = approvalTimeoutMs;
  }
  get status() {
    return structuredClone(this.#status);
  }
  get bridge() {
    return this.#bridge;
  }
  async start() {
    if (this.#status.ready && this.#monitor) return this.status;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }
  async #start() {
    await this.stop();
    this.#status.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.#status.weixinConnectionState = "connecting";
    this.#status.lastError = null;
    try {
      await this.#harness.ensureRunning();
      this.#status.harnessReachable = true;
      await this.#api.notifyStart({
        baseUrl: this.#config.baseUrl,
        token: this.#token
      });
      this.#bridge = new WeixinHarnessBridge({
        api: this.#api,
        baseUrl: this.#config.baseUrl,
        token: this.#token,
        ownerUserId: this.#config.ownerUserId,
        harness: this.#harness,
        state: this.#state,
        status: this.#status,
        logger: this.#logger,
        replyTimeoutMs: this.#replyTimeoutMs,
        maxMessageChars: this.#maxMessageChars,
        approvalTimeoutMs: this.#approvalTimeoutMs
      });
      this.#abortController = new AbortController();
      this.#status.ready = true;
      this.#status.weixinConnectionState = "connected";
      this.#status.lastCheckedAt = Date.now();
      const signal = this.#abortController.signal;
      this.#monitor = this.#runMonitor(signal).catch((error) => {
        if (signal.aborted) return;
        this.#status.ready = false;
        this.#status.weixinConnectionState = "failed";
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.error?.(`[dsh-weixin] account ${this.#config.botId} monitor stopped:`, error);
      });
      return this.status;
    } catch (error) {
      this.#status.ready = false;
      this.#status.weixinConnectionState = "failed";
      this.#status.lastError = error?.message ?? String(error);
      throw error;
    }
  }
  async #runMonitor(signal) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const response = await this.#api.getUpdates({
          baseUrl: this.#config.baseUrl,
          token: this.#token,
          getUpdatesBuf: this.#state.getUpdatesBuf(),
          signal
        });
        if (signal.aborted) return;
        const rejected = response?.ret !== void 0 && response.ret !== 0 || response?.errcode !== void 0 && response.errcode !== 0;
        if (rejected) {
          const code = response.errcode ?? response.ret;
          throw new WeixinApiError(
            code === -14 ? "stale-token" : "updates-rejected",
            code === -14 ? "\u5FAE\u4FE1\u767B\u5F55\u51ED\u636E\u5DF2\u5931\u6548\uFF0C\u8BF7\u79FB\u9664\u8D26\u53F7\u540E\u91CD\u65B0\u626B\u7801\u3002" : "\u5FAE\u4FE1\u6D88\u606F\u540C\u6B65\u8BF7\u6C42\u88AB\u62D2\u7EDD\u3002"
          );
        }
        consecutiveFailures = 0;
        this.#status.ready = true;
        this.#status.weixinConnectionState = "connected";
        this.#status.lastCheckedAt = Date.now();
        this.#status.lastError = null;
        for (const message of response?.msgs ?? []) {
          await this.#bridge.accept(message);
        }
        if (typeof response?.get_updates_buf === "string" && response.get_updates_buf) {
          await this.#state.setGetUpdatesBuf(response.get_updates_buf);
        }
      } catch (error) {
        if (signal.aborted) return;
        consecutiveFailures += 1;
        this.#status.lastError = error?.message ?? String(error);
        this.#logger.warn?.(
          `[dsh-weixin] account ${this.#config.botId} poll failed (${consecutiveFailures}/3):`,
          error
        );
        if (error instanceof WeixinApiError && error.code === "stale-token") throw error;
        if (consecutiveFailures >= 3) throw error;
        await delay(Math.min(2e3 * 2 ** (consecutiveFailures - 1), 1e4), signal);
      }
    }
  }
  async stop() {
    const monitor = this.#monitor;
    const bridge = this.#bridge;
    const wasStarted = Boolean(this.#abortController || monitor || this.#status.ready);
    this.#abortController?.abort();
    this.#abortController = null;
    this.#monitor = null;
    await monitor?.catch(() => void 0);
    await bridge?.waitForIdle();
    this.#bridge = null;
    if (wasStarted) {
      try {
        await this.#api.notifyStop({
          baseUrl: this.#config.baseUrl,
          token: this.#token,
          signal: AbortSignal.timeout(1e4)
        });
      } catch (error) {
        this.#logger.warn?.(`[dsh-weixin] account ${this.#config.botId} stop notification failed:`, error);
      }
    }
    this.#status.ready = false;
    this.#status.weixinConnectionState = "idle";
    return this.status;
  }
};

// plugin-src/host/connection-supervisor.mjs
var DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1e3, 3e3, 5e3, 1e4, 3e4]);
function retryDelays(value) {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_RETRY_DELAYS_MS];
  const valid = value.filter((delay2) => Number.isFinite(delay2) && delay2 >= 0);
  return valid.length > 0 ? valid : [...DEFAULT_RETRY_DELAYS_MS];
}
var ConnectionSupervisor = class {
  #controller;
  #harness;
  #logger;
  #retryDelays;
  #healthyIntervalMs;
  #setTimeout;
  #clearTimeout;
  #timer = null;
  #running = null;
  #retryIndex = 0;
  #closed = false;
  #started = false;
  #ready;
  #resolveReady;
  constructor({
    controller,
    harness,
    logger = console,
    retryDelaysMs,
    healthyIntervalMs = 15e3,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    if (!controller || typeof controller.initialize !== "function" || typeof controller.status !== "function") {
      throw new TypeError("ConnectionSupervisor requires a controller");
    }
    if (!harness || typeof harness.ensureRunning !== "function") {
      throw new TypeError("ConnectionSupervisor requires a Harness client");
    }
    this.#controller = controller;
    this.#harness = harness;
    this.#logger = logger;
    this.#retryDelays = retryDelays(retryDelaysMs);
    this.#healthyIntervalMs = Number.isFinite(healthyIntervalMs) && healthyIntervalMs >= 0 ? healthyIntervalMs : 15e3;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#ready = new Promise((resolve2) => {
      this.#resolveReady = resolve2;
    });
  }
  get ready() {
    return this.#ready;
  }
  start() {
    if (this.#started || this.#closed) return this;
    this.#started = true;
    this.#schedule(0);
    return this;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) this.#clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => void 0);
    this.#resolveReady?.(null);
    this.#resolveReady = null;
  }
  #schedule(delayMs) {
    if (this.#closed) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#run();
    }, delayMs);
    this.#timer?.unref?.();
  }
  async #run() {
    if (this.#closed || this.#running) return;
    const operation = this.#reconcile();
    this.#running = operation;
    try {
      await operation;
    } finally {
      if (this.#running === operation) this.#running = null;
    }
  }
  async #reconcile() {
    try {
      await this.#harness.ensureRunning();
      if (this.#closed) return;
      const status = await this.#controller.initialize();
      if (this.#closed) return;
      this.#resolveReady?.(status);
      this.#resolveReady = null;
      const { configured, connected } = status.totals;
      if (connected < configured) {
        const delayMs = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
        this.#retryIndex += 1;
        this.#logger.warn?.(
          `[dsh-weixin] ${connected}/${configured} accounts connected; retrying in ${delayMs}ms`
        );
        this.#schedule(delayMs);
        return;
      }
      this.#retryIndex = 0;
      this.#schedule(this.#healthyIntervalMs);
    } catch (error) {
      if (this.#closed) return;
      const delayMs = this.#retryDelays[Math.min(this.#retryIndex, this.#retryDelays.length - 1)];
      this.#retryIndex += 1;
      this.#logger.warn?.(`[dsh-weixin] connection reconciliation failed; retrying in ${delayMs}ms`, error);
      this.#schedule(delayMs);
    }
  }
};
function createConnectionSupervisor(options) {
  return new ConnectionSupervisor(options);
}

// plugin-src/host/production.mjs
function harnessOrigin(webServer, configured) {
  if (configured !== void 0) return new URL(configured);
  const port = webServer?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("dsh-weixin requires an initialized DSH webServer port");
  }
  return new URL(`http://127.0.0.1:${port}`);
}
function pluginPaths(config) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
  const root = resolve(config.dataDir ?? join(dshHome, "integrations", "dsh-weixin"));
  return {
    root,
    config: resolve(config.configPath ?? join(root, "config.json")),
    accounts: resolve(config.accountsDir ?? join(root, "accounts"))
  };
}
async function applySessionPolicy(ctx, sessionId, policy, logger) {
  try {
    const session = ctx.sessions?.get?.(sessionId);
    if (!session || typeof session.append !== "function") return;
    if (policy.sandbox) session.append("sandbox/mode", { mode: policy.sandbox });
    if (policy.approval) session.append("approval/policy", { policy: policy.approval });
  } catch (error) {
    logger?.warn?.("[dsh-weixin] failed to apply session permission policy:", error);
  }
}
async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError("dsh-weixin requires ctx.credentials");
  if (!ctx?.webServer) throw new TypeError("dsh-weixin requires ctx.webServer");
  const ConfigStore = internals.ConfigStore ?? WeixinConfigStore;
  const StateStore = internals.StateStore ?? WeixinStateStore;
  const Harness = internals.HarnessClient ?? HarnessClient;
  const Controller = internals.Controller ?? WeixinController;
  const Runtime = internals.Runtime ?? WeixinRuntime;
  const api = internals.api ?? createWeixinApi();
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = typeof ctx.logger === "function" ? ctx.logger("dsh-weixin") : ctx.logger ?? console;
  const paths = pluginPaths(config);
  const approvals = config.approvals ?? {};
  const sessionPolicy = approvals.sessionPolicy === "inherit" ? null : { sandbox: "workspace-write", approval: "ask" };
  const approvalTimeoutMs = Number.isInteger(approvals.timeoutMs) ? approvals.timeoutMs : 3e5;
  const configStore = await new ConfigStore(paths.config).load();
  const stateStores = /* @__PURE__ */ new Map();
  const statePath = (botId) => resolve(paths.accounts, botId, "state.json");
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new StateStore(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const harness = new Harness({
    baseUrl: harnessOrigin(ctx.webServer, config.harnessBaseUrl),
    workspace: resolve(config.workspace ?? process.cwd()),
    agentPreset: config.agentPreset ?? "standard",
    autostart: false,
    dshBin: config.dshBin ?? "dsh",
    onSessionCreated: sessionPolicy ? (sessionId) => applySessionPolicy(ctx, sessionId, sessionPolicy, logger) : null
  });
  const controller = new Controller({
    api,
    credentials: ctx.credentials,
    configStore,
    logger,
    createRuntime: async ({ botId, config: accountConfig, token }) => {
      const state = await stateFor(botId);
      return new Runtime({
        api,
        config: accountConfig,
        token,
        harness,
        state,
        replyTimeoutMs: config.replyTimeoutMs ?? 6e5,
        maxMessageChars: config.maxMessageChars ?? 4e3,
        approvalTimeoutMs,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args)
        }
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === "function") {
        await state.remove();
        return;
      }
      try {
        await unlink3(statePath(botId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs
  }).start();
  const disposeApprovalAnswerer = typeof ctx.on === "function" ? ctx.on("approval/request", (req, next) => {
    const bridge = controller.bridgeForSession(req?.agent?.session?.id);
    if (!bridge) return next();
    return bridge.submitApproval(req);
  }, { prepend: true }) : null;
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      if (disposeApprovalAnswerer) {
        try {
          disposeApprovalAnswerer();
        } catch (error) {
          logger.warn?.("[dsh-weixin] failed to dispose the approval answerer:", error);
        }
      }
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    }
  };
}

// plugin-src/host/rpc.mjs
import QRCode from "qrcode";
var WEIXIN_RPC_CHANNEL = "/weixin";
var WEIXIN_ENDPOINTS = Object.freeze({
  status: "connection.status",
  beginProvisioning: "provision.begin",
  pollProvisioning: "provision.poll",
  submitVerification: "provision.verify",
  cancelProvisioning: "provision.cancel",
  reconnectBot: "bot.reconnect",
  deleteBot: "bot.delete"
});
var WEIXIN_RPC_ENDPOINTS = Object.freeze(Object.values(WEIXIN_ENDPOINTS));
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function payloadFailure(endpoint, payload) {
  if (!isRecord(payload)) return "Payload must be an object.";
  if (endpoint === WEIXIN_ENDPOINTS.status) {
    return exactKeys(payload, []) ? null : "connection.status does not accept fields.";
  }
  if (endpoint === WEIXIN_ENDPOINTS.beginProvisioning) {
    return exactKeys(payload, ["locale"]) && (payload.locale === void 0 || payload.locale === "zh-CN") ? null : "provision.begin received unsupported fields.";
  }
  if ([WEIXIN_ENDPOINTS.pollProvisioning, WEIXIN_ENDPOINTS.cancelProvisioning].includes(endpoint)) {
    return exactKeys(payload, ["attemptId"]) && validId(payload.attemptId) ? null : `${endpoint} requires an attemptId.`;
  }
  if (endpoint === WEIXIN_ENDPOINTS.submitVerification) {
    return exactKeys(payload, ["attemptId", "verifyCode"]) && validId(payload.attemptId) && typeof payload.verifyCode === "string" && /^\d{4,8}$/.test(payload.verifyCode) ? null : "provision.verify requires an attemptId and a 4-to-8-digit code.";
  }
  if (endpoint === WEIXIN_ENDPOINTS.reconnectBot) {
    return exactKeys(payload, ["botId"]) && validId(payload.botId) ? null : "bot.reconnect requires a botId.";
  }
  if (endpoint === WEIXIN_ENDPOINTS.deleteBot) {
    return exactKeys(payload, ["botId", "confirm"]) && validId(payload.botId) && payload.confirm === true ? null : "bot.delete requires a botId and confirm=true.";
  }
  return "Unknown Weixin endpoint.";
}
function badRequest(message) {
  return { ok: false, error: { code: "bad-request", message } };
}
function cancelled() {
  return { ok: false, error: { code: "cancelled", message: "The request was cancelled." } };
}
function internalFailure() {
  return {
    ok: false,
    error: { code: "weixin-operation-failed", message: "\u5FAE\u4FE1\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" }
  };
}
async function qrDataUrl(value) {
  return QRCode.toDataURL(value, {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320
  });
}
async function withEncodedQr(value, encodeQr) {
  if (!value || !value.verificationUrl) return value;
  return {
    ...value,
    qrCodeDataUrl: await encodeQr(value.verificationUrl)
  };
}
async function publicStatus(status, encodeQr) {
  const safe = structuredClone(status);
  if (safe.provisioning) safe.provisioning = await withEncodedQr(safe.provisioning, encodeQr);
  return safe;
}
function assertController(controller) {
  if (!controller || typeof controller.status !== "function" || typeof controller.startProvisioning !== "function" || typeof controller.registrationStatus !== "function" || typeof controller.submitVerification !== "function" || typeof controller.cancelProvisioning !== "function" || typeof controller.reconnectBot !== "function" || typeof controller.deleteBot !== "function") {
    throw new TypeError("A complete Weixin controller is required");
  }
}
function createWeixinRpcHandler(controller, { encodeQr = qrDataUrl } = {}) {
  assertController(controller);
  const qrCache = /* @__PURE__ */ new Map();
  const cachedEncode = (url) => {
    let encoded = qrCache.get(url);
    if (!encoded) {
      if (qrCache.size >= 16) qrCache.delete(qrCache.keys().next().value);
      encoded = Promise.resolve().then(() => encodeQr(url));
      qrCache.set(url, encoded);
    }
    return encoded;
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return cancelled();
    if (!WEIXIN_RPC_ENDPOINTS.includes(endpoint)) return badRequest("Unknown Weixin endpoint.");
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return badRequest(invalid);
    try {
      let value;
      if (endpoint === WEIXIN_ENDPOINTS.status) {
        value = await publicStatus(await controller.status(), cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.beginProvisioning) {
        const started = await controller.startProvisioning();
        if (signal?.aborted) {
          await controller.cancelProvisioning(started.attemptId);
          return cancelled();
        }
        value = await withEncodedQr(started, cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.pollProvisioning) {
        const current = await controller.registrationStatus(payload.attemptId);
        if (!current) return badRequest("The provisioning attempt no longer exists.");
        value = await withEncodedQr(current, cachedEncode);
      } else if (endpoint === WEIXIN_ENDPOINTS.submitVerification) {
        value = await withEncodedQr(
          await controller.submitVerification(payload.attemptId, payload.verifyCode),
          cachedEncode
        );
      } else if (endpoint === WEIXIN_ENDPOINTS.cancelProvisioning) {
        value = await controller.cancelProvisioning(payload.attemptId);
        if (!value) return badRequest("The provisioning attempt no longer exists.");
      } else if (endpoint === WEIXIN_ENDPOINTS.reconnectBot) {
        value = await publicStatus(await controller.reconnectBot(payload.botId), cachedEncode);
      } else {
        value = await publicStatus(await controller.deleteBot(payload.botId), cachedEncode);
      }
      return signal?.aborted ? cancelled() : { ok: true, value };
    } catch {
      return signal?.aborted ? cancelled() : internalFailure();
    }
  };
}
function installWeixinRpc(ctx, controller, options) {
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== "function") {
    throw new TypeError("DSH Host Connection RPC is required");
  }
  return ctx.connection.rpc.handle(
    WEIXIN_RPC_CHANNEL,
    createWeixinRpcHandler(controller, options),
    { authority: "loopback" }
  );
}

// plugin-src/host/index.mjs
var name = "dsh-weixin-host";
var inject = ["connection", "credentials", "webServer"];
async function apply(ctx, config = {}) {
  if (config?.controller) return installWeixinRpc(ctx, config.controller, config.rpcOptions);
  const production = await createProductionController(ctx, config, config.internals);
  const disposeRpc = installWeixinRpc(ctx, production.controller, config.rpcOptions);
  ctx.effect(() => async () => {
    await production.close();
  }, "dsh-weixin: close account connections");
  return disposeRpc;
}
function createWeixinHostPlugin(config) {
  return Object.freeze({ name, inject, apply: (ctx) => apply(ctx, config) });
}
export {
  ConnectionSupervisor,
  WEIXIN_ENDPOINTS,
  WEIXIN_RPC_CHANNEL,
  WEIXIN_RPC_ENDPOINTS,
  WeixinController,
  WeixinRuntime,
  apply,
  createConnectionSupervisor,
  createProductionController,
  createWeixinHostPlugin,
  createWeixinRpcHandler,
  inject,
  installWeixinRpc,
  name
};
