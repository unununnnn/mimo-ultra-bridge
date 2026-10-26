import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { UltraPageDriver } from '../browser/ultraDriver';
import { AccountPool } from '../browser/accountPool';
import { OpenAIChatRequest } from '../types';
import { buildCompositePrompt, StreamSieve } from '../parser/streamSieve';

export function createOpenAIRouter(driver: UltraPageDriver, pool: AccountPool): Router {
  const router = Router();

  const SUPPORTED_MODELS = [
    'mimo-v2.6-pro-ultraspeed',
    'mimo-v2.6-pro',
    'mimo-v2.5-pro-ultraspeed',
    'mimo-v2.5-pro',
    'mimo-ultra',
  ];

  router.get('/models', (_req: Request, res: Response) => {
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: 'list',
      data: SUPPORTED_MODELS.map((id) => ({
        id,
        object: 'model',
        created,
        owned_by: 'xiaomi-mimo-ultra-playwright',
      })),
    });
  });

  router.get('/accounts', (_req: Request, res: Response) => {
    res.json({
      accounts: pool.listAccounts().map((a) => ({
        id: a.id,
        label: a.label,
        hasValidToken: a.hasValidToken,
        busy: a.busy,
        totalTurns: a.totalTurns,
        cooldownRemainingMs: Math.max(0, a.cooldownUntil - Date.now()),
      })),
    });
  });

  router.post('/chat/completions', async (req: Request, res: Response) => {
    const body = req.body as OpenAIChatRequest;
    const model = body.model || process.env.DEFAULT_MIMO_MODEL || 'mimo-v2.6-pro-ultraspeed';
    const isStream = Boolean(body.stream);
    const enableThinking =
      body.reasoning_effort !== undefined
        ? true
        : process.env.ENABLE_THINKING_DEFAULT !== 'false';

    const prompt = buildCompositePrompt(body.messages || [], body.tools);
    const completionId = `chatcmpl-${uuidv4().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    const sieve = new StreamSieve();

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
        const payload = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      writeChunk({ role: 'assistant' });

      let hasToolCalls = false;
      for await (const evt of driver.streamQuery({ prompt, enableThinking })) {
        if (evt.type === 'error') {
          writeChunk({ content: `\n[Bridge Error: ${evt.error}]` }, 'stop');
          break;
        }
        if (evt.type === 'text' && evt.content) {
          const sieved = sieve.push(evt.content);
          if (sieved.thinkingDelta) {
            writeChunk({ reasoning_content: sieved.thinkingDelta });
          }
          if (sieved.textDelta) {
            writeChunk({ content: sieved.textDelta });
          }
        }
      }

      const finalSieved = sieve.flush();
      if (finalSieved.thinkingDelta) {
        writeChunk({ reasoning_content: finalSieved.thinkingDelta });
      }
      if (finalSieved.textDelta) {
        writeChunk({ content: finalSieved.textDelta });
      }
      if (finalSieved.toolCalls && finalSieved.toolCalls.length > 0) {
        hasToolCalls = true;
        writeChunk({
          tool_calls: finalSieved.toolCalls.map((tc, index) => ({
            index,
            ...tc,
          })),
        });
      }

      writeChunk({}, hasToolCalls ? 'tool_calls' : 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Non-streaming mode: buffer chunks from Playwright driver and return complete response
    let fullText = '';
    let fullThinking = '';
    let usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    for await (const evt of driver.streamQuery({ prompt, enableThinking })) {
      if (evt.type === 'error') {
        res.status(502).json({
          error: {
            message: evt.error,
            type: 'upstream_playwright_error',
          },
        });
        return;
      }
      if (evt.type === 'text' && evt.content) {
        const sieved = sieve.push(evt.content);
        if (sieved.thinkingDelta) fullThinking += sieved.thinkingDelta;
        if (sieved.textDelta) fullText += sieved.textDelta;
      }
      if (evt.type === 'usage' && evt.usage) {
        usage = {
          prompt_tokens: evt.usage.promptTokens,
          completion_tokens: evt.usage.completionTokens,
          total_tokens: evt.usage.totalTokens,
        };
      }
    }

    const tail = sieve.flush();
    if (tail.thinkingDelta) fullThinking += tail.thinkingDelta;
    if (tail.textDelta) fullText += tail.textDelta;

    const toolCalls = tail.toolCalls;
    res.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: toolCalls && toolCalls.length > 0 ? fullText || null : fullText,
            ...(fullThinking ? { reasoning_content: fullThinking } : {}),
            ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage,
    });
  });

  return router;
}
