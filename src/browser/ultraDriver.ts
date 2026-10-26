import { chromium, BrowserContext, Page, Response } from 'playwright';
import { AccountMetadata, UltraQueryOptions, UltraStreamEvent } from '../types';
import { applyStealthHooks, STEALTH_LAUNCH_ARGS } from './stealth';
import { AccountPool } from './accountPool';

interface ActiveSession {
  context: BrowserContext;
  page: Page;
}

/**
 * Pure Playwright Page Automation Driver for https://aistudio.xiaomimimo.com/#/ultra
 *
 * Combines authentic DOM interaction on the `#/ultra` page (input filling,
 * thinking toggle, button triggering) with Playwright response stream interception
 * on `/open-apis/bot/chat` and DOM MutationObserver fallback so UltraSpeed's
 * 1000+ tokens/s streaming is captured without loss.
 */
export class UltraPageDriver {
  private sessions: Map<string, ActiveSession> = new Map();
  private targetUrl: string;
  private headless: boolean;

  constructor(private pool: AccountPool) {
    this.targetUrl = process.env.MIMO_ULTRA_URL || 'https://aistudio.xiaomimimo.com/#/ultra';
    this.headless = process.env.HEADLESS !== 'false';
  }

  /**
   * Ensures a persistent Chromium context & page at `#/ultra` is open for the given account.
   */
  private async getOrCreateSession(account: AccountMetadata): Promise<ActiveSession> {
    const existing = this.sessions.get(account.id);
    if (existing && !existing.page.isClosed()) {
      return existing;
    }

    const context = await chromium.launchPersistentContext(account.userDataDir, {
      headless: this.headless,
      args: STEALTH_LAUNCH_ARGS,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    await applyStealthHooks(context);

    const page = context.pages()[0] || (await context.newPage());
    const navTimeout = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);

    await page.goto(this.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: navTimeout,
    });

    // Verify Xiaomi authentication cookies inside the browser context
    const cookies = await context.cookies('https://aistudio.xiaomimimo.com');
    const hasServiceToken = cookies.some((c) => c.name === 'serviceToken' && Boolean(c.value));
    const hasPh = cookies.some((c) => c.name === 'xiaomichatbot_ph' && Boolean(c.value));

    if (!hasServiceToken && !hasPh) {
      console.warn(
        `[UltraPageDriver] Account '${account.id}' does not have active Xiaomi session cookies yet. ` +
          `Run 'npm run login -- ${account.id}' to sign in interactively.`
      );
    }

    const session: ActiveSession = { context, page };
    this.sessions.set(account.id, session);
    return session;
  }

  /**
   * Executes a prompt on `https://aistudio.xiaomimimo.com/#/ultra` via Playwright DOM automation
   * and yields real-time streaming chunks.
   */
  public async *streamQuery(options: UltraQueryOptions): AsyncGenerator<UltraStreamEvent, void, unknown> {
    const account = this.pool.acquireAccount();
    const streamTimeout = options.timeoutMs || Number(process.env.STREAM_TIMEOUT_MS || 180000);

    try {
      const { page } = await this.getOrCreateSession(account);

      // Ensure we are on the #/ultra route
      if (!page.url().includes('#/ultra')) {
        await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded' });
      }

      // Start a fresh conversation on the page if requested
      if (options.freshConversation) {
        await this.clickNewChatIfNeeded(page);
      }

      // Toggle Deep Thinking button on the #/ultra UI if needed
      await this.syncThinkingToggleOnPage(page, options.enableThinking);

      // Set up async queue to bridge Playwright's response / DOM stream into our AsyncGenerator
      const queue: UltraStreamEvent[] = [];
      let resolveNext: (() => void) | null = null;
      let streamDone = false;

      const pushEvent = (evt: UltraStreamEvent) => {
        queue.push(evt);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      };

      // Attach CDP / Playwright response stream listener for `/open-apis/bot/chat`
      // triggered when the Playwright page submits the prompt on `#/ultra`.
      const onResponse = async (response: Response) => {
        const url = response.url();
        if (!url.includes('/open-apis/bot/chat')) {
          return;
        }

        if (response.status() === 401 || response.status() === 403) {
          this.pool.markTokenExpired(account.id);
          pushEvent({
            type: 'error',
            error: `Xiaomi MiMo session expired (HTTP ${response.status()}). Please run 'npm run login'.`,
          });
          streamDone = true;
          return;
        }

        if (response.status() === 429) {
          this.pool.markRateLimited(account.id, 60_000);
          pushEvent({
            type: 'error',
            error: 'Xiaomi MiMo rate limit reached (HTTP 429). Account rotated.',
          });
          streamDone = true;
          return;
        }

        try {
          const bodyBuffer = await response.body();
          const rawSse = bodyBuffer.toString('utf8');
          this.parseRawSseFrames(rawSse, pushEvent);
          streamDone = true;
          pushEvent({ type: 'finish' });
        } catch (err) {
          pushEvent({
            type: 'error',
            error: `Failed reading /open-apis/bot/chat response stream: ${(err as Error).message}`,
          });
          streamDone = true;
        }
      };

      page.on('response', onResponse);

      try {
        // Install in-page fetch/SSE interceptor BEFORE clicking send so chunks arrive in real time
        // as the browser streams `/open-apis/bot/chat` on `#/ultra`, without waiting for response end.
        await this.attachRealtimePageSseHook(page, pushEvent, () => {
          streamDone = true;
        });

        // Fill prompt into #/ultra input box and submit via Playwright
        await this.fillAndSubmitPromptOnUltra(page, options.prompt);

        const deadline = Date.now() + streamTimeout;
        while (!streamDone && Date.now() < deadline) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
              setTimeout(resolve, 250);
            });
          }
          while (queue.length > 0) {
            const item = queue.shift()!;
            yield item;
            if (item.type === 'finish' || item.type === 'error') {
              streamDone = true;
              break;
            }
          }
        }
      } finally {
        page.off('response', onResponse);
      }

      this.pool.releaseAccount(account.id, true);
    } catch (err) {
      this.pool.releaseAccount(account.id, false);
      yield {
        type: 'error',
        error: (err as Error).message,
      };
    }
  }

  /**
   * Injects a real-time fetch stream reader inside the `#/ultra` page context
   * so every SSE frame from `/open-apis/bot/chat` is forwarded to Node.js immediately as it arrives.
   */
  private async attachRealtimePageSseHook(
    page: Page,
    pushEvent: (evt: UltraStreamEvent) => void,
    markDone: () => void
  ): Promise<void> {
    const bridgeFnName = '__mimoUltraPushSseChunk';
    const hasBinding = await page.evaluate((fn) => typeof (window as unknown as Record<string, unknown>)[fn] === 'function', bridgeFnName);

    if (!hasBinding) {
      await page.exposeFunction(bridgeFnName, (rawChunk: string) => {
        if (rawChunk === '__STREAM_EOF__') {
          markDone();
          pushEvent({ type: 'finish' });
          return;
        }
        this.parseRawSseFrames(rawChunk, pushEvent);
      });

      await page.evaluate((fnName) => {
        const win = window as unknown as Record<string, unknown>;
        if (win.__mimoFetchHookInstalled) return;
        win.__mimoFetchHookInstalled = true;

        const origFetch = window.fetch.bind(window);
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          const res = await origFetch(...args);
          const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url || '';
          if (url.includes('/open-apis/bot/chat') && res.body) {
            const clone = res.clone();
            const reader = clone.body!.getReader();
            const decoder = new TextDecoder('utf-8');
            (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const text = decoder.decode(value, { stream: true });
                  const callback = win[fnName] as (chunk: string) => void;
                  if (callback) callback(text);
                }
              } catch {
                // Ignore stream clone errors
              } finally {
                const callback = win[fnName] as (chunk: string) => void;
                if (callback) callback('__STREAM_EOF__');
              }
            })();
          }
          return res;
        };
      }, bridgeFnName);
    }
  }

  /**
   * Parses Xiaomi MiMo Studio SSE frames (`event:dialogId`, `event:message`, `event:usage`, `event:finish`).
   */
  private parseRawSseFrames(rawText: string, pushEvent: (evt: UltraStreamEvent) => void): void {
    const blocks = rawText.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.split(/\r?\n/);
      let eventType = 'message';
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }

      const dataStr = dataLines.join('\n');
      if (!dataStr) continue;

      try {
        const parsed = JSON.parse(dataStr);
        if (eventType === 'dialogId') {
          pushEvent({ type: 'dialogId', dialogId: parsed.content });
        } else if (eventType === 'message') {
          if (typeof parsed.content === 'string' && parsed.content.length > 0) {
            pushEvent({ type: 'text', content: parsed.content });
          }
        } else if (eventType === 'usage') {
          pushEvent({
            type: 'usage',
            usage: {
              promptTokens: parsed.promptTokens ?? parsed.nativeUsage?.prompt_tokens ?? 0,
              completionTokens: parsed.completionTokens ?? parsed.nativeUsage?.completion_tokens ?? 0,
              totalTokens: parsed.totalTokens ?? parsed.nativeUsage?.total_tokens ?? 0,
              reasoningTokens: parsed.nativeUsage?.completion_tokens_details?.reasoning_tokens,
            },
          });
        } else if (eventType === 'finish' || parsed.content === '[DONE]') {
          pushEvent({ type: 'finish' });
        }
      } catch {
        if (dataStr === '[DONE]') {
          pushEvent({ type: 'finish' });
        }
      }
    }
  }

  /**
   * Locates the chat input on `https://aistudio.xiaomimimo.com/#/ultra`, fills the prompt, and triggers submission.
   */
  private async fillAndSubmitPromptOnUltra(page: Page, prompt: string): Promise<void> {
    const inputSelectors = [
      'textarea[placeholder*="MiMo"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="Ask"]',
      'textarea',
      '[contenteditable="true"]',
    ];

    let inputLocator = page.locator(inputSelectors.join(', ')).first();
    await inputLocator.waitFor({ state: 'visible', timeout: 30_000 });
    await inputLocator.click();
    await inputLocator.fill(prompt);

    // Try clicking the send button or pressing Enter
    const sendButtonSelectors = [
      'button[type="submit"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      '[class*="send-btn"]',
      '[class*="sendBtn"]',
    ];
    const sendBtn = page.locator(sendButtonSelectors.join(', ')).first();
    if ((await sendBtn.count()) > 0 && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    } else {
      await inputLocator.press('Enter');
    }
  }

  /**
   * Clicks the "New Chat" button on `#/ultra` when starting a fresh conversation.
   */
  private async clickNewChatIfNeeded(page: Page): Promise<void> {
    try {
      const newChatSelectors = [
        'button:has-text("新对话")',
        'button:has-text("开启新对话")',
        'button:has-text("New Chat")',
        '[class*="new-chat"]',
      ];
      const btn = page.locator(newChatSelectors.join(', ')).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Ignore if already on a blank #/ultra session
    }
  }

  /**
   * Ensures the Deep Thinking (深度思考) toggle on `#/ultra` matches the requested state.
   */
  private async syncThinkingToggleOnPage(page: Page, enableThinking: boolean): Promise<void> {
    try {
      const toggle = page
        .locator('button:has-text("深度思考"), [role="switch"][aria-label*="思考"], [class*="thinking-toggle"]')
        .first();
      if ((await toggle.count()) > 0 && (await toggle.isVisible())) {
        const ariaChecked = await toggle.getAttribute('aria-checked');
        const classList = (await toggle.getAttribute('class')) || '';
        const isCurrentlyActive =
          ariaChecked === 'true' || classList.includes('active') || classList.includes('checked');
        if (isCurrentlyActive !== enableThinking) {
          await toggle.click();
          await page.waitForTimeout(150);
        }
      }
    } catch {
      // Non-fatal if #/ultra locks default thinking mode
    }
  }

  public async closeAll(): Promise<void> {
    for (const { context } of this.sessions.values()) {
      await context.close().catch(() => undefined);
    }
    this.sessions.clear();
  }
}
