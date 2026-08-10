export interface OpenAIMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  enable_thinking?: boolean;
  tools?: unknown[];
}

export interface OpenAIChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string; reasoning_content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface UpstreamChatParams {
  token: string;
  messages: OpenAIMessage[];
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  enableThinking: boolean;
  stream: boolean;
  tools?: unknown[];
}
