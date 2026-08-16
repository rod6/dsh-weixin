# dsh-weixin

[中文](#中文) · [English](#english)

## 中文

通过微信扫码，把腾讯微信机器人接入 DeepSeek Harness。插件运行在 `dsh web` 的 Host 进程内：设置页只负责显示一次性二维码和脱敏状态，扫码得到的 `bot_token` 直接写入 Harness 凭据服务，随后由 Host 通过腾讯 iLink Bot API 长轮询收消息并把回答发回微信。

### 前提条件

- DeepSeek Harness `0.1.0-rc.6`，Node.js `>=22.19`；
- 手机微信账号已获得微信机器人功能。若微信里尚未出现相关入口，请先检查「我 → 设置 → 插件」；该功能由腾讯分批开放，插件代码无法绕过账号侧的开放范围；
- 运行 Harness 的设备能够访问 `*.weixin.qq.com`。

### 安装与扫码绑定

```bash
npx -y github:rod6/dsh-weixin install
```

安装后重启 `dsh web`，然后：

1. 打开「设置 → 插件 → 微信」；
2. 点击「扫码绑定微信」；
3. 使用手机微信扫描页面上的二维码，并在手机上确认；
4. 如果手机显示配对数字，在 Harness 页面输入该数字；
5. 页面显示“运行正常”后，在微信里向已绑定的机器人发送消息。

扫码成功后必须同时满足以下条件，页面才会显示在线：

1. 腾讯 iLink 返回 `bot_token`、机器人账号 ID、扫码用户 ID 和消息 API 地址；
2. `bot_token` 已写入 Harness Host 凭据服务；
3. 非敏感账号配置已原子保存；
4. 微信 `notifystart` 验证通过并启动 `getupdates` 长轮询；
5. 插件能访问当前 Harness Host。

可以重复扫码添加多个微信账号。每个账号拥有独立凭据引用、长轮询、同步游标、消息去重记录和 Harness 会话映射；一个账号重连或移除不会影响其他账号。

### 消息行为

- 只接受扫码确认用户发来的私聊消息，其他用户默认拒绝；
- 支持文字，以及微信已经附带文字识别结果的语音；
- 当前不把图片、文件、视频或无转写语音送入 Harness；
- 每个微信用户映射到持久 Harness 会话，支持连续对话；
- `/new` 清除当前会话映射，`/status` 检查连接，`/help` 显示帮助；
- Harness 回答较长时会拆成多条微信文本，每条都沿用入站消息的 `context_token`；
- 运行期间把中间过程转发到微信：每次工具调用发一条 `🔧 正在调用工具：<名称>`，工具返回后把**实际结果文本**（截断预览）发到微信，如 `⏳ fetch 完成：Fetch succeeded — title "…"`，最终回答照常发送；
- Harness 需要用户批准的操作（如沙箱升级、越出会话工作区写文件）会以 `🔒 需要你批准：<工具>` 的形式发到微信，回复「允许 / 同意 / 是 / ok / yes」放行，回复「拒绝 / 取消 / 否 / no」拒绝；待批准期间其他消息会收到提示而不会误送入模型。

### 配置

插件配置通过 cordis patch 的 `config` 传入：

```yaml
- insert:
    id: rod6-dsh-weixin
    name: '@rod6/dsh-weixin'
    config:
      approvals:
        sessionPolicy: ask      # ask（默认）| inherit（沿用部署默认，不主动改会话策略）
        timeoutMs: 300000       # 待批准请求超时（毫秒），超时自动拒绝（fail-closed）
      progress:
        resultPreviewChars: 600 # 工具结果转发到微信时的预览长度（字符），超出截断
```

- `approvals.sessionPolicy: 'ask'`（默认）：新创建的微信会话设为 `workspace-write` 沙箱 + `ask` 审批策略，审批请求才会真正触发并转发到微信；设为 `'inherit'` 则沿用部署默认（例如 `danger-full-access`，不触发审批）。
- `progress.resultPreviewChars`：工具结果预览长度，默认 600 字符，超出部分以 `…（已截断）` 结尾，避免刷屏。
- 审批应答只认绑定用户；多个并发审批按 FIFO 排队，逐条回复即可。

### 安全设计

- 浏览器永远不会收到或提交 `bot_token`、二维码内部令牌、扫码用户 ID 或凭据引用；
- Host RPC 仅允许 Harness loopback 页面调用；
- `bot_token` 只保存在 `ctx.credentials`，非敏感配置位于 `$DSH_HOME/integrations/dsh-weixin/config.json`；
- 微信消息 API 地址必须是 `https://weixin.qq.com` 或其子域，且只能使用默认 HTTPS 端口，防止授权令牌被发送到任意重定向主机；
- 配对数字只保存在当前 Host 内存，绑定完成、取消或失败后立即清除；
- 删除账号会停止它自己的长轮询，删除它自己的凭据、配置、同步游标和会话映射。

### 本地开发与验证

```bash
git clone https://github.com/rod6/dsh-weixin.git
cd dsh-weixin
npm install
npm run check
node bin/dsh-weixin.mjs install --source .
```

只验证腾讯扫码端点是否仍兼容，而不打印或保存二维码内容：

```bash
npm run verify:protocol
```

完整人工验收需要在 Harness 设置页完成一次手机扫码，再从微信发送一条测试消息并确认 Harness 回答返回。自动测试覆盖请求头与协议字段、二维码/配对码状态机、凭据回滚、长轮询生命周期、消息上下文、用户授权、RPC 脱敏、多账号删除隔离和客户端输入校验。

### 协议来源与许可

微信 iLink 请求格式基于腾讯官方 MIT 项目 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 2.4.6 适配；本项目移除了 OpenClaw 运行时依赖，改用 DeepSeek Harness 的 Host RPC、凭据服务和会话 API。具体来源版本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目本身使用 MIT License。

## English

Connect Tencent Weixin bots to DeepSeek Harness through QR-code authorization. The plugin runs inside the `dsh web` Host process. The browser receives only a one-time QR image and redacted status; the resulting `bot_token` is written directly to the Harness credential provider.

### Install

```bash
npx -y github:rod6/dsh-weixin install
```

Restart `dsh web`, open **Settings → Plugins → Weixin**, generate a QR code, scan it with Weixin, confirm on the phone, and enter the displayed pairing digits if requested. The account is ready when the page reports a healthy iLink long-poll connection.

The Weixin bot feature must already be available to the phone account. Tencent rolls out that feature independently; this plugin cannot enable it for an ineligible account.

The current release supports direct text messages and voice messages that already contain Weixin transcription. It isolates credentials, sync cursors, deduplication, and Harness sessions per account. It also forwards intermediate progress (tool calls, plus a truncated preview of each tool's actual result text) and Harness approval prompts to the owner's WeChat: reply 「允许」/「同意」/「是」/「ok」/「yes」 to allow, 「拒绝」/「取消」/「否」/「no」 to reject. See the Chinese section for the complete behavior, security model, verification commands, and the plugin config (`approvals.sessionPolicy` / `approvals.timeoutMs` / `progress.resultPreviewChars`).
