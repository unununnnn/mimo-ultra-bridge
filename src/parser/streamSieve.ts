import { v4 as uuidv4 } from 'uuid';
import { OpenAIMessage, OpenAITool, OpenAIToolCall } from '../types';

export interface SieveChunk {
  thinkingDelta?: string;
  textDelta?: string;
  toolCalls?: OpenAIToolCall[];
}

/**
 * Formats conversation history + optional tool definitions into a single composite prompt
 * suitable for driving the `#/ultra` web UI, injecting MiMoML tool instructions when tools are provided.
 */
export function buildCompositePrompt(messages: OpenAIMessage[], tools?: OpenAITool[]): string {
  const parts: string[] = [];

  if (tools && tools.length > 0) {
    const toolDefs = tools
      .map((t) => {
        return `- ${t.function.name}: ${t.function.description || ''}\n  Parameters JSON Schema: ${JSON.stringify(
          t.function.parameters || { type: 'object', properties: {} }
        )}`;
      })
      .join('\n');

    parts.push(
      [
        'You have access to the following tools. When you need to call a tool, output ONLY the following XML block:',
        '<|MiMoML|tool_calls>',
        '<|MiMoML|invoke name="TOOL_NAME">',
        '<|MiMoML|parameter name="PARAM_NAME"><![CDATA[PARAM_VALUE]]></|MiMoML|parameter>',
        '</|MiMoML|invoke>',
        '</|MiMoML|tool_calls>',
        '',
        'Available Tools:',
        toolDefs,
      ].join('\n')
    );
  }

  for (const msg of messages) {
    const contentText =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
        ? msg.content
            .map((c) => (c.type === 'text' ? c.text || '' : `[Image: ${c.image_url?.url || ''}]`))
            .join('\n')
        : '';

    if (msg.role === 'system') {
      parts.push(`[System Instruction]\n${contentText}`);
    } else if (msg.role === 'user') {
      parts.push(`[User]\n${contentText}`);
    } else if (msg.role === 'assistant') {
      const toolCallStr = msg.tool_calls
        ? msg.tool_calls
            .map((tc) => `<tool_call>${tc.function.name}(${tc.function.arguments})</tool_call>`)
            .join('\n')
        : '';
      parts.push(`[Assistant]\n${contentText}${toolCallStr ? '\n' + toolCallStr : ''}`);
    } else if (msg.role === 'tool') {
      parts.push(`[Tool Result (${msg.tool_call_id || msg.name || 'tool'})]\n${contentText}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Streaming state machine that separates `<think>...</think>` blocks from regular content
 * and buffers `<|MiMoML|tool_calls>` / `<tool_call>` blocks at the end of the turn.
 */
export class StreamSieve {
  private inThinkBlock = false;
  private buffer = '';
  private toolBuffer = '';
  private inToolBlock = false;

  public push(chunk: string): SieveChunk {
    this.buffer += chunk.replace(/\u0000/g, "");
    const out: SieveChunk = {};

    // Process <think> and </think> transitions
    while (this.buffer.length > 0) {
      if (!this.inThinkBlock) {
        const thinkStart = this.buffer.indexOf('<think>');
        if (thinkStart !== -1) {
          const before = this.buffer.slice(0, thinkStart);
          if (before) {
            out.textDelta = (out.textDelta || '') + before;
          }
          this.buffer = this.buffer.slice(thinkStart + '<think>'.length);
          this.inThinkBlock = true;
          continue;
        }

        // Check for tool call opening tag
        const toolStart = this.findToolStart(this.buffer);
        if (toolStart !== -1) {
          const before = this.buffer.slice(0, toolStart);
          if (before) {
            out.textDelta = (out.textDelta || '') + before;
          }
          this.inToolBlock = true;
          this.toolBuffer += this.buffer.slice(toolStart);
          this.buffer = '';
          break;
        }

        if (this.inToolBlock) {
          this.toolBuffer += this.buffer;
          this.buffer = '';
          break;
        }

        // Hold back partial '<' tag prefix at the end of buffer
        const lastLt = this.buffer.lastIndexOf('<');
        if (lastLt !== -1 && this.buffer.length - lastLt < 22) {
          const safe = this.buffer.slice(0, lastLt);
          if (safe) {
            out.textDelta = (out.textDelta || '') + safe;
          }
          this.buffer = this.buffer.slice(lastLt);
          break;
        }

        out.textDelta = (out.textDelta || '') + this.buffer;
        this.buffer = '';
      } else {
        const thinkEnd = this.buffer.indexOf('</think>');
        if (thinkEnd !== -1) {
          const thinkingPart = this.buffer.slice(0, thinkEnd);
          if (thinkingPart) {
            out.thinkingDelta = (out.thinkingDelta || '') + thinkingPart;
          }
          this.buffer = this.buffer.slice(thinkEnd + '</think>'.length);
          this.inThinkBlock = false;
          continue;
        }

        const lastLt = this.buffer.lastIndexOf('<');
        if (lastLt !== -1 && this.buffer.length - lastLt < 10) {
          const safe = this.buffer.slice(0, lastLt);
          if (safe) {
            out.thinkingDelta = (out.thinkingDelta || '') + safe;
          }
          this.buffer = this.buffer.slice(lastLt);
          break;
        }

        out.thinkingDelta = (out.thinkingDelta || '') + this.buffer;
        this.buffer = '';
      }
    }

    return out;
  }

  public flush(): SieveChunk {
    const out: SieveChunk = {};
    if (this.buffer) {
      if (this.inThinkBlock) {
        out.thinkingDelta = this.buffer;
      } else if (this.inToolBlock) {
        this.toolBuffer += this.buffer;
      } else {
        out.textDelta = this.buffer;
      }
      this.buffer = '';
    }

    if (this.toolBuffer) {
      const parsedTools = extractToolCalls(this.toolBuffer);
      if (parsedTools.length > 0) {
        out.toolCalls = parsedTools;
      } else {
        out.textDelta = (out.textDelta || '') + this.toolBuffer;
      }
      this.toolBuffer = '';
    }

    return out;
  }

  private findToolStart(text: string): number {
    const markers = ['<|MiMoML|tool_calls>', '<tool_call>', '<function_call>'];
    let earliest = -1;
    for (const m of markers) {
      const idx = text.indexOf(m);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
      }
    }
    return earliest;
  }
}

/**
 * Extracts structured OpenAI tool calls from MiMoML or XML tool call blocks.
 */
export function extractToolCalls(raw: string): OpenAIToolCall[] {
  const results: OpenAIToolCall[] = [];

  // Strategy 1: <|MiMoML|invoke name="...">...</|MiMoML|invoke>
  const invokeRegex = /<\|MiMoML\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|MiMoML\|invoke>/g;
  let match: RegExpExecArray | null;
  while ((match = invokeRegex.exec(raw)) !== null) {
    const fnName = match[1];
    const body = match[2];
    const args: Record<string, unknown> = {};
    const paramRegex =
      /<\|MiMoML\|parameter\s+name="([^"]+)"\s*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\|MiMoML\|parameter>/g;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      const key = pMatch[1];
      const val = pMatch[2] !== undefined ? pMatch[2] : pMatch[3];
      try {
        args[key] = JSON.parse(val);
      } catch {
        args[key] = val;
      }
    }
    results.push({
      id: `call_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
      type: 'function',
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }

  // Strategy 2: <function_call>{"name": "...", "arguments": {...}}</function_call>
  const jsonTagRegex = /<(?:function_call|tool_call)>\s*([\s\S]*?)\s*<\/(?:function_call|tool_call)>/g;
  while ((match = jsonTagRegex.exec(raw)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name) {
        results.push({
          id: `call_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments:
              typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || {}),
          },
        });
      }
    } catch {
      // Ignore malformed JSON block
    }
  }

  return results;
}
