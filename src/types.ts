export interface AccountMetadata {
  id: string;
  label: string;
  userDataDir: string;
  userId?: string;
  hasValidToken: boolean;
  lastUsedAt: number;
  cooldownUntil: number;
  totalTurns: number;
  busy: boolean;
}

export interface UltraQueryOptions {
  prompt: string;
  enableThinking: boolean;
  freshConversation?: boolean;
  conversationId?: string;
  timeoutMs?: number;
}

export type UltraStreamEventType =
  | 'dialogId'
  | 'thinking'
  | 'text'
  | 'usage'
  | 'finish'
  | 'error';

export interface UltraStreamEvent {
  type: UltraStreamEventType;
  content?: string;
  dialogId?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
  error?: string;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
  tools?: OpenAITool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessageRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{
      type: 'text' | 'image' | 'tool_use' | 'tool_result';
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>;
    }>;
  }>;
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  tools?: AnthropicTool[];
}
