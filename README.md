# MiMo Ultra Bridge (`mimo-ultra-bridge`)

参考 [AdhirajPersonal/antigravity-argon-bridge](https://github.com/AdhirajPersonal/antigravity-argon-bridge) 的设计思想，使用 **TypeScript + Playwright Stealth CDP** 纯页面自动化驱动 [Xiaomi MiMo Studio Ultra (`https://aistudio.xiaomimimo.com/#/ultra`)](https://aistudio.xiaomimimo.com/#/ultra)，并将其转化为本地 **OpenAI (`/v1/chat/completions`)** 与 **Anthropic (`/v1/messages`)** 双兼容 API 服务。

## 核心特性

* **纯 Playwright `#/ultra` 自动化引擎**：真实驱动持久化 Chromium 访问 `https://aistudio.xiaomimimo.com/#/ultra`，自动完成输入框填充、深度思考开关同步与发送操作。
* **Stealth CDP 反检测与实时流式捕获**：内置 `navigator.webdriver` 抹除与真实 Chrome 指纹伪装；在页面上下文挂载实时流读取器监听 `/open-apis/bot/chat`，零延迟透传 UltraSpeed 1000+ TPS 的输出流。
* **多账号隔离池与故障转移**：每个小米账号拥有独立的 Chromium Profile 目录（默认存放在 `~/.xiaomi-mimo-ultra/profiles/<accountId>`），遇到 429 限流或 `serviceToken` 过期自动轮询切换。
* **OpenAI + Anthropic 双协议兼容**：
  * `POST /v1/chat/completions`（支持流式/非流式、`<think>` 自动分离为 `reasoning_content`、MiMoML 工具调用提取为 `tool_calls`）
  * `POST /v1/messages`（支持 Claude Code / RikkaHub / Cursor，自动将 `claude-opus-4-6`、`claude-sonnet-4-6` 等映射至 `mimo-v2.6-pro-ultraspeed`，按 `thinking` -> `text` -> `tool_use` 顺序输出事件块）

## 快速开始

### 1. 安装依赖

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

### 2. 登录小米账号（支持添加多个账号）

运行交互式登录命令，会弹出独立的 Chromium 窗口打开 `https://aistudio.xiaomimimo.com/#/ultra`：

```bash
# 登录默认账号
npm run login

# 登录第 2 个备用账号（用于多账号轮询）
npm run login -- account2
```

在弹出的窗口中完成小米账号登录，检测到 `serviceToken` 与 `xiaomichatbot_ph` 后窗口会自动保存并关闭。

### 3. 启动本地 API 服务

```bash
# 开发模式运行
npm run dev

# 或编译后运行
npm run build
npm start
```

服务默认监听 `http://127.0.0.1:8080`，默认 API Key 为 `sk-mimo-ultra`。

## 调用示例

### OpenAI `/v1/chat/completions`

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-mimo-ultra" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-pro-ultraspeed",
    "messages": [{"role": "user", "content": "用 TypeScript 实现一个并发限流器"}],
    "reasoning_effort": "high",
    "stream": true
  }'
```

### Anthropic `/v1/messages`（对接 Claude Code 等）

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_API_KEY=sk-mimo-ultra
claude
```
