import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { WeixinConfigStore } from '../../src/config-store.mjs';
import { HarnessClient } from '../../src/harness-client.mjs';
import { WeixinStateStore } from '../../src/state-store.mjs';
import { createWeixinApi } from '../../src/weixin-api.mjs';
import { WeixinController } from '../../src/weixin-controller.mjs';
import { WeixinRuntime } from '../../src/weixin-runtime.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';

function harnessOrigin(webServer, configured) {
  if (configured !== undefined) return new URL(configured);
  const port = webServer?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh-weixin requires an initialized DSH webServer port');
  }
  return new URL(`http://127.0.0.1:${port}`);
}

function pluginPaths(config) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  const root = resolve(config.dataDir ?? join(dshHome, 'integrations', 'dsh-weixin'));
  return {
    root,
    config: resolve(config.configPath ?? join(root, 'config.json')),
    accounts: resolve(config.accountsDir ?? join(root, 'accounts')),
  };
}

/**
 * Best-effort per-session permission override for newly created sessions:
 * appends the sandbox-mode and approval-policy events the harness folds on
 * every read. In-process only; silently no-ops when the session is not live
 * on this host (e.g. the plugin drives a remote harness).
 */
async function applySessionPolicy(ctx, sessionId, policy, logger) {
  try {
    const session = ctx.sessions?.get?.(sessionId);
    if (!session || typeof session.append !== 'function') return;
    if (policy.sandbox) session.append('sandbox/mode', { mode: policy.sandbox });
    if (policy.approval) session.append('approval/policy', { policy: policy.approval });
  } catch (error) {
    logger?.warn?.('[dsh-weixin] failed to apply session permission policy:', error);
  }
}

export async function createProductionController(ctx, config = {}, internals = {}) {
  if (!ctx?.credentials) throw new TypeError('dsh-weixin requires ctx.credentials');
  if (!ctx?.webServer) throw new TypeError('dsh-weixin requires ctx.webServer');

  const ConfigStore = internals.ConfigStore ?? WeixinConfigStore;
  const StateStore = internals.StateStore ?? WeixinStateStore;
  const Harness = internals.HarnessClient ?? HarnessClient;
  const Controller = internals.Controller ?? WeixinController;
  const Runtime = internals.Runtime ?? WeixinRuntime;
  const api = internals.api ?? createWeixinApi();
  const createSupervisor = internals.createConnectionSupervisor ?? createConnectionSupervisor;
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('dsh-weixin')
    : (ctx.logger ?? console);
  const paths = pluginPaths(config);
  const approvals = config.approvals ?? {};
  // Default 'ask': newly created sessions get workspace-write sandbox + the
  // ask approval policy so approvals actually fire and reach the owner's
  // WeChat. Set `approvals.sessionPolicy: 'inherit'` to keep the deployment
  // default (e.g. danger-full-access, no prompts) instead.
  const sessionPolicy = approvals.sessionPolicy === 'inherit'
    ? null
    : { sandbox: 'workspace-write', approval: 'ask' };
  const approvalTimeoutMs = Number.isInteger(approvals.timeoutMs) ? approvals.timeoutMs : 300_000;
  const configStore = await new ConfigStore(paths.config).load();
  const stateStores = new Map();

  const statePath = (botId) => resolve(paths.accounts, botId, 'state.json');
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
    agentPreset: config.agentPreset ?? 'standard',
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    onSessionCreated: sessionPolicy
      ? (sessionId) => applySessionPolicy(ctx, sessionId, sessionPolicy, logger)
      : null,
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
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        maxMessageChars: config.maxMessageChars ?? 4_000,
        approvalTimeoutMs,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === 'function') {
        await state.remove();
        return;
      }
      try {
        await unlink(statePath(botId));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  });
  const supervisor = createSupervisor({
    controller,
    harness,
    logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  // Approval answerer for this plugin's mapped sessions: forwards each
  // harness approval/request to the owning account's WeChat and waits for the
  // owner's 「允许」/「拒绝」 reply. `prepend` puts this answerer ahead of the
  // web-UI answerer, which claims every request unconditionally; requests for
  // sessions this plugin does not own fall through to `next()`.
  const disposeApprovalAnswerer = typeof ctx.on === 'function'
    ? ctx.on('approval/request', (req, next) => {
      const bridge = controller.bridgeForSession(req?.agent?.session?.id);
      if (!bridge) return next();
      return bridge.submitApproval(req);
    }, { prepend: true })
    : null;
  return {
    controller,
    ready: supervisor.ready,
    async close() {
      if (disposeApprovalAnswerer) {
        try {
          disposeApprovalAnswerer();
        } catch (error) {
          logger.warn?.('[dsh-weixin] failed to dispose the approval answerer:', error);
        }
      }
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}
