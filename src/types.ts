// Core shared types for sarvam-cli

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentPart = TextContent | ToolCallContent;

export interface Message {
  role: Role;
  content: string | ContentPart[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatCompletionDelta {
  content?: string;
  reasoning_content?: string; // Sarvam-native: thinking tokens
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface StreamCallbacks {
  onDelta: (delta: ChatCompletionDelta) => void;
  onDone: (full: { content: string; tool_calls: ToolCallParsed[] }) => void;
  onError: (err: Error) => void;
}

export interface ToolCallParsed {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Provider {
  name: string;
  getModel(): string;
  setModel(model: string): void;
  /** Known-good model ids. Empty means unconstrained — any string the endpoint accepts. */
  listModels(): readonly string[];
  chatStream(
    messages: Message[],
    tools: ToolDef[],
    opts: { temperature?: number; reasoning_effort?: "low" | "medium" | "high" },
    cb: StreamCallbacks
  ): Promise<void>;
}
