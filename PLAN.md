# MiMo Ultra Bridge (`mimo-ultra-bridge`) 架构与开发方案

> 参考项目：[AdhirajPersonal/antigravity-argon-bridge](https://github.com/AdhirajPersonal/antigravity-argon-bridge)  
> 目标站点：[Xiaomi MiMo Studio Ultra (`https://aistudio.xiaomimimo.com/#/ultra`)](https://aistudio.xiaomimimo.com/#/ultra)

## 1. 核心设计目标

本项目复刻 [AdhirajPersonal/antigravity-argon-bridge](https://github.com/AdhirajPersonal/antigravity-argon-bridge) 的核心设计（**100% 本地凭据隔离、Stealth CDP 反检测浏览器驱动、多账号池自动故障转移、会话状态复用**），针对 [Xiaomi MiMo Studio Ultra (`https://aistudio.xiaomimimo.com/#/ultra`)](https://aistudio.xiaomimimo.com/#/ultra)（搭载 [MiMo-V2.6-Pro-UltraSpeed](https://mimo.mi.com/models/en-US/mimo-v2.6-pro-ultraspeed) / [MiMo-V2.5-Pro-UltraSpeed](https://mimo.xiaomi.com/blog/mimo-tilert-1000tps)）进行纯 Playwright 页面自动化操作，并对外提供标准 **OpenAI (`/v1/chat/completions`)** 与 **Anthropic (`/v1/messages`)** 双兼容本地 API 服务，可直接接入 Claude Code、Cursor、Cline、Roo-Code、Antigravity IDE 等工具。

## 2. 端到端数据流与分层架构

1. **客户端接入层**：支持任何 OpenAI 兼容客户端（调用 `POST /v1/chat/completions`、`GET /v1/models`）与 Anthropic 兼容客户端（如 Claude Code 调用 `POST /v1/messages`、`POST /v1/messages/count_tokens`）。
2. **协议转换与流式筛分层（`src/routes/*` + `src/parser/streamSieve.ts`）**：
   - 将多轮对话历史与工具定义（`tools`）封装为 `#/ultra` 复合提示词（含 `<|MiMoML|tool_calls>` 协议注入）。
   - 实时扫描输出流，将 `<think>...</think>` 思考过程剥离为 OpenAI 的 `reasoning_content` 或 Anthropic 的 `thinking_delta` 事件块。
   - 实时拦截工具调用块（`<|MiMoML|tool_calls>` / `<tool_call>`）并在流结束时组装为标准 `tool_calls` 或 `tool_use` 块。
3. **多账号隔离池（`src/browser/accountPool.ts`）**：
   - 每个小米账号拥有独立的 Chromium 用户数据目录（默认 `~/.xiaomi-mimo-ultra/profiles/<accountId>`）。
   - 采用 Round-Robin 轮询调度，单账号并发自动加锁；遇到 HTTP 429 自动进入冷却期并切换下一个可用账号，遇到 401/403 标记 `serviceToken` 过期。
4. **Playwright Stealth 页面自动化引擎（`src/browser/ultraDriver.ts` + `src/browser/stealth.ts`）**：
   - 启动持久化 Chromium Context 并注入 Stealth CDP 反检测脚本（抹除 `navigator.webdriver`、补全 `window.chrome.runtime`、统一语言与时区指纹）。
   - 常驻导航至 `https://aistudio.xiaomimimo.com/#/ultra`，通过 Playwright 定位 `#/ultra` 输入框、同步“深度思考”开关状态、填充 Prompt 并触发提交。
   - 在页面上下文中挂载实时 `window.fetch` 流克隆钩子与 `page.on('response')` 监听器，在页面发起 `/open-apis/bot/chat` 请求时零延迟透传 SSE 数据帧（`event:dialogId`、`event:message`、`event:usage`、`event:finish`）。

## 3. 核心模块清单

| 文件路径 | 对标 `antigravity-argon-bridge` 模块 | 核心职责 |
| :--- | :--- | :--- |
| `src/browser/stealth.ts` | Stealth CDP Automation Engine | 注入 CDP 反检测脚本与启动参数，防止自动化特征被前端风控拦截 |
| `src/browser/accountPool.ts` | Multi-Account Failover & Sandbox | 管理 `~/.xiaomi-mimo-ultra/profiles/` 多账号持久化目录、轮询负载均衡与限流冷却 |
| `src/browser/ultraDriver.ts` | Playwright Page Driver | 纯 Playwright 操作 `#/ultra` 页面 DOM（新对话、深度思考切换、输入与发送）并实时捕获 SSE 流 |
| `src/cli/login.ts` | Interactive Account Linker | `npm run login` 弹出真实 Chromium 窗口登录小米账号，检测到 `serviceToken` 与 `xiaomichatbot_ph` 后自动保存并关闭 |
| `src/parser/streamSieve.ts` | Reasoning & Tool Sieve | 实时状态机分离 `<think>` 思考链与正文，并提取 MiMoML / XML 工具调用 |
| `src/routes/openai.ts` | OpenAI Compatibility Layer | 提供 `/v1/chat/completions`（流式与非流式）、`/v1/models` 与 `/v1/accounts` |
| `src/routes/anthropic.ts` | Anthropic Compatibility Layer | 提供 `/v1/messages` 与 `/v1/messages/count_tokens`，内置 `claude-opus-4-6` / `claude-sonnet-4-6` 自动映射 |
| `src/index.ts` | Local Bridge Server | Express 服务入口、Bearer / `x-api-key` 双鉴权与优雅退出（自动回收 Chromium 实例） |
| `scripts/push-to-github.sh` | GitHub Repo Bootstrapper | 一键通过 `gh repo create` 或 `git remote add` 将本地已初始化的 Git 仓库推送到你的 GitHub 新仓库 |

## 4. 本地验证与一键上传 GitHub 流程

1. **推送至你的 GitHub 新仓库**：
   - 解压 `mimo-ultra-bridge.zip`（内部已包含完整 `.git` 初始化提交记录）。
   - 若已安装 GitHub CLI（`gh`），直接执行 `bash scripts/push-to-github.sh mimo-ultra-bridge --public` 即可自动创建远端仓库并完成推送。
   - 若使用普通 Git，在 GitHub 网页新建空仓库后执行 `git remote add origin https://github.com/<你的用户名>/mimo-ultra-bridge.git && git push -u origin main`。
2. **安装与绑定小米账号**：
   - 执行 `npm install && npx playwright install chromium`。
   - 执行 `npm run login` 弹出浏览器登录小米账号（支持 `npm run login -- account2` 添加多账号）。
3. **启动桥接服务**：
   - 执行 `npm run dev`（或 `npm run build && npm start`），即可在 `http://127.0.0.1:8080/v1` 使用 OpenAI 与 Anthropic 接口。
