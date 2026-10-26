import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { UltraPageDriver } from '../browser/ultraDriver';
import { AnthropicMessageRequest, OpenAIMessage, OpenAITool } from '../types';
import { buildCompositePrompt, StreamSieve } from '../parser/streamSieve';

/**
 * Maps Claude model identifiers (e.g. from Claude Code CLI) to Xiaomi MiMo Ultra models.
 */
export function resolveAnthropicModel(requestedModel: string): string {
  const map: Record<string, string> = {
    'claude-opus-4-6': 'mimo-v2.6-pro-ultraspeed',
    'claude-sonnet-4-6': 'mimo-v2.6-pro-ultraspeed',
    'claude-haiku-4-5': 'mimo-v2.6-pro-ultraspeed',
    'claude-3-7-sonnet-20250219': 'mimo-v2.6-pro-ultraspeed',
    'claude-3-5-sonnet-20241022': 'mimo-v2.6-pro-ultraspeed',
  };
  return map[requestedModel] || process.env.DEFAULT_MIMO_MODEL || 'mimo-v2.6-pro-ultraspeed';
}

export function createAnthropicRouter(driver: UltraPageDriver): Router {
  const router = Router();

  router.post('/messages/count_tokens', (req: Request, res: Response) => {
    const raw = JSON.stringify(req.body || {});
    const estimatedTokens = Math.max(1, Math.ceil(raw.length / 3.5));
    res.json({ input_tokens: estimatedTokens });
  });

  router.post('/messages', async (req: Request, res: Response) => {
    const body = req.body as AnthropicMessageRequest;
    const model = body.model || 'claude-sonnet-4-6';
    const isStream = Boolean(body.stream);
    const enableThinking =
      body.thinking?.type === 'enabled'
        ? true
        : body.thinking?.type === 'disabled'
        ? false
        : process.env.ENABLE_THINKING_DEFAULT !== 'false';

    // Convert Anthropic request format into OpenAIMessage[] + OpenAITool[]
    const openAiMessages: OpenAIMessage[] = [];
    if (body.system) {
      const sysText =
        typeof body.system === 'string'
          ? body.system
          : body.system.map((s) => s.text).join('\n');
      openAiMessages.push({ role: 'system', content: sysText });
    }

    for (const m of body.messages || []) {
      if (typeof m.content === 'string') {
        openAiMessages.push({ role: m.role, content: m.content });
      } else if (Array.isArray(m.content)) {
        const textSegments: string[] = [];
        for (const block of m.content) {
          if (block.type === 'text' && block.text) {
            textSegments.push(block.text);
          } else if (block.type === 'tool_result') {
            const resultContent =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                ? block.content.map((c) => c.text || '').join('\n')
                : '';
            openAiMessages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: resultContent,
            });
          } else if (block.type === 'tool_use') {
            textSegments.push(
              `<tool_call>${block.name}(${JSON.stringify(block.input || {})})</tool_call>`
            );
          }
        }
        if (textSegments.length > 0) {
          openAiMessages.push({ role: m.role, content: textSegments.join('\n') });
        }
      }
    }

    const openAiTools: OpenAITool[] | undefined = body.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const prompt = buildCompositePrompt(openAiMessages, openAiTools);
    const msgId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    const sieve = new StreamSieve();

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const sendSse = (event: string, data: Record<string, unknown>) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendSse('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let blockIndex = -1;
      let activeBlockType: 'thinking' | 'text' | null = null;

      const ensureBlockOpen = (targetType: 'thinking' | 'text') => {
        if (activeBlockType === targetType) return;
        if (activeBlockType !== null) {
          sendSse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }
        blockIndex += 1;
        activeBlockType = targetType;
        if (targetType === 'thinking') {
          sendSse('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          });
        } else {
          sendSse('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          });
        }
      };

      let outputTokens = 0;

      for await (const evt of driver.streamQuery({ prompt, enableThinking })) {
        if (evt.type === 'error') {
          ensureBlockOpen('text');
          sendSse('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: `\n[Bridge Error: ${evt.error}]` },
          });
          break;
        }
        if (evt.type === 'text' && evt.content) {
          const sieved = sieve.push(evt.content);
          if (sieved.thinkingDelta) {
            ensureBlockOpen('thinking');
            sendSse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: sieved.thinkingDelta },
            });
          }
          if (sieved.textDelta) {
            ensureBlockOpen('text');
            sendSse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: sieved.textDelta },
            });
          }
        }
        if (evt.type === 'usage' && evt.usage) {
          outputTokens = evt.usage.completionTokens;
        }
      }

      const tail = sieve.flush();
      if (tail.thinkingDelta) {
        ensureBlockOpen('thinking');
        sendSse('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: tail.thinkingDelta },
        });
      }
      if (tail.textDelta) {
        ensureBlockOpen('text');
        sendSse('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: tail.textDelta },
        });
      }

      if (activeBlockType !== null) {
        sendSse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        activeBlockType = null;
      }

      let stopReason = 'end_turn';
      if (tail.toolCalls && tail.toolCalls.length > 0) {
        stopReason = 'tool_use';
        for (const tc of tail.toolCalls) {
          blockIndex += 1;
          const toolUseId = `toolu_${uuidv4().replace(/-/g, '').slice(0, 20)}`;
          sendSse('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: toolUseId,
              name: tc.function.name,
              input: {},
            },
          });
          sendSse('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          });
          sendSse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }
      }

      sendSse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      sendSse('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }

    // Non-streaming Anthropic response
    let fullThinking = '';
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const evt of driver.streamQuery({ prompt, enableThinking })) {
      if (evt.type === 'error') {
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: evt.error },
        });
        return;
      }
      if (evt.type === 'text' && evt.content) {
        const sieved = sieve.push(evt.content);
        if (sieved.thinkingDelta) fullThinking += sieved.thinkingDelta;
        if (sieved.textDelta) fullText += sieved.textDelta;
      }
      if (evt.type === 'usage' && evt.usage) {
        inputTokens = evt.usage.promptTokens;
        outputTokens = evt.usage.completionTokens;
      }
    }

    const tail = sieve.flush();
    if (tail.thinkingDelta) fullThinking += tail.thinkingDelta;
    if (tail.textDelta) fullText += tail.textDelta;

    const contentBlocks: Array<Record<string, unknown>> = [];
    if (fullThinking) {
      contentBlocks.push({ type: 'thinking', thinking: fullThinking });
    }
    if (fullText) {
      contentBlocks.push({ type: 'text', text: fullText });
    }
    if (tail.toolCalls && tail.toolCalls.length > 0) {
      for (const tc of tail.toolCalls) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(tc.function.arguments);
        } catch {
          parsedInput = { raw: tc.function.arguments };
        }
        contentBlocks.push({
          type: 'tool_use',
          id: `toolu_${uuidv4().replace(/-/g, '').slice(0, 20)}`,
          name: tc.function.name,
          input: parsedInput,
        });
      }
    }

    res.json({
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: contentBlocks,
      stop_reason: tail.toolCalls && tail.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    });
  });

  return router;
}
