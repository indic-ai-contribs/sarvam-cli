// Agent loop — manages the conversation, streams model output, dispatches
// tool calls (with approval), and feeds results back until the model stops
// calling tools. Works for both single-prompt and interactive REPL modes.

import { Message, Provider, ToolCallParsed } from "../types.js";
import { TOOL_DEFS, executeTool, ToolCtx } from "../tools/index.js";

const SYSTEM_PROMPT = `You are sarvam-cli, an agentic coding assistant running in the user's terminal.
You can read, write, and edit files, and run shell commands — but only with the user's approval.

How to work:
- Always read a file before editing it. Never guess at content.
- Prefer the smallest change that solves the problem. Use \`patch\` for targeted edits; reserve \`write_file\` for new files or full rewrites.
- For shell commands, prefer read-only inspection first (ls, cat, rg, git diff) before anything that mutates state.
- When you're done with the task, give a concise summary of what you changed and why. Don't over-explain.
- If a tool call fails, read the error, adjust, and retry — don't repeat the exact same call.

You operate relative to the current working directory. Use relative paths.`;

export interface AgentOpts {
  provider: Provider;
  cwd: string;
  approve: (tool: string, summary: string, detail: string) => Promise<boolean>;
  temperature?: number;
  reasoning_effort?: "low" | "medium" | "high";
  onText?: (chunk: string) => void;      // streamed assistant text
  onReasoning?: (chunk: string) => void; // streamed reasoning tokens (Sarvam)
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  maxTurns?: number;
}

export async function runAgent(
  messages: Message[],
  userMsg: string,
  opts: AgentOpts
): Promise<Message[]> {
  const ctx: ToolCtx = { cwd: opts.cwd, approve: opts.approve };
  const conversation: Message[] = [...messages, { role: "user", content: userMsg }];
  const maxTurns = opts.maxTurns ?? 20;

  for (let turn = 0; turn < maxTurns; turn++) {
    let assistantText = "";
    let toolCalls: ToolCallParsed[] = [];

    await new Promise<void>((resolve, reject) => {
      opts.provider.chatStream(
        conversation,
        TOOL_DEFS,
        { temperature: opts.temperature, reasoning_effort: opts.reasoning_effort },
        {
          onDelta: (delta) => {
            if (delta.content && opts.onText) opts.onText(delta.content);
            if (delta.reasoning_content && opts.onReasoning) opts.onReasoning(delta.reasoning_content);
          },
          onDone: ({ content, tool_calls }) => {
            assistantText = content;
            toolCalls = tool_calls;
            resolve();
          },
          onError: (err) => reject(err),
        }
      );
    });

    // Record assistant turn.
    const assistantMsg: Message = {
      role: "assistant",
      content: assistantText || "",
      ...(toolCalls.length
        ? { /* tool_calls stored on the message for OpenAI-style APIs */ }
        : {}),
    };
    conversation.push(assistantMsg);

    if (toolCalls.length === 0) {
      // No more tool calls — the model is done.
      break;
    }

    // Execute each tool call and append results.
    for (const tc of toolCalls) {
      opts.onToolCall?.(tc.name, tc.arguments);
      const result = await executeTool(tc.name, tc.arguments, ctx);
      opts.onToolResult?.(tc.name, result);
      conversation.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
        name: tc.name,
      });
    }
  }

  return conversation;
}

export { SYSTEM_PROMPT };
