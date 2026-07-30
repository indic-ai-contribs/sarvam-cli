// Agent loop — manages the conversation, streams model output, dispatches
// tool calls (with approval), and feeds results back until the model stops
// calling tools. Works for both single-prompt and interactive REPL modes.

import { Message, Provider, ToolCallParsed } from "../types.js";
import { TOOL_DEFS, executeTool, ToolCtx } from "../tools/index.js";

const SYSTEM_PROMPT = `You are sarvam-cli, an agentic coding assistant running in the user's terminal.
You can read, write, and edit files, and run shell commands — but only with the user's approval.

CRITICAL OUTPUT RULES:
- Output ONLY the final answer the user should see. Never output your internal reasoning, planning, or chain-of-thought as text.
- Do not narrate what you're about to do (e.g. "I need to list files", "Let me read the file"). Just call the tool silently, then present the result.
- Do not repeat or restate the user's request. Do not speculate about what the user "probably wants." Just do the task and give the result.
- Your text output should be the answer, summary, or code — nothing else. If you need to think, use tool calls, not prose.
- If you read a file and need to edit it, call the patch or write_file tool immediately after reading. Do not just read the file and stop.

TASK COMPLETION:
- Complete ALL steps the user requested. If the user asks for 3 things, do all 3 — do not stop after one.
- Do not output "No response requested" or similar. If you ran a tool, either continue with the next step or give a summary of what was done.
- Only stop when the entire task is finished. If you're unsure whether the task is complete, continue working.

WORKING DIRECTORY:
- You operate relative to the current working directory: {CWD}.
- Only read, write, and edit files WITHIN this directory. Never access files outside it (no "/", no "/app/", no "/home/").
- Use relative paths like "src/index.ts" or "./README.md", not absolute paths.
- If you need to see what files exist, use run_shell with "ls" or "find . -type f".

How to work:
- Always read a file before editing it. Never guess at content.
- Prefer the smallest change that solves the problem. Use \`patch\` for targeted edits; reserve \`write_file\` for new files or full rewrites.
- For shell commands, prefer read-only inspection first (ls, cat, rg, git diff) before anything that mutates state.
- When you're done with the task, give a concise summary of what you changed and why. Don't over-explain.
- If a tool call fails, read the error, adjust, and retry — don't repeat the exact same call.`;

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

export function buildSystemPrompt(cwd: string): string {
  return SYSTEM_PROMPT.replace("{CWD}", cwd);
}

export async function runAgent(
  messages: Message[],
  userMsg: string,
  opts: AgentOpts
): Promise<Message[]> {
  const ctx: ToolCtx = { cwd: opts.cwd, approve: opts.approve };
  const conversation: Message[] = [...messages, { role: "user", content: userMsg }];
  const maxTurns = opts.maxTurns ?? 20;
  let toolsExecuted = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    let assistantText = "";
    let toolCalls: ToolCallParsed[] = [];
    let textBuffer = ""; // Buffer streamed text — only flush if no tool calls

    await new Promise<void>((resolve, reject) => {
      opts.provider.chatStream(
        conversation,
        TOOL_DEFS,
        { temperature: opts.temperature, reasoning_effort: opts.reasoning_effort },
        {
          onDelta: (delta) => {
            if (delta.content) {
              textBuffer += delta.content;
            }
            if (delta.reasoning_content && opts.onReasoning) opts.onReasoning(delta.reasoning_content);
          },
          onDone: ({ content, tool_calls }) => {
            assistantText = content;
            toolCalls = tool_calls;
            // Only flush buffered text to the user if there are NO tool calls.
            // If tool calls exist, the text was chain-of-thought narration
            // (e.g. "The user wants me to...") and should be suppressed.
            if (tool_calls.length === 0 && textBuffer && opts.onText) {
              opts.onText(textBuffer);
            }
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
    };
    conversation.push(assistantMsg);

    if (toolCalls.length === 0) {
      // No more tool calls — the model is done.
      // But if the model returned empty/trivial content after doing partial
      // work, it likely stopped prematurely. Nudge it to continue.
      const trivialResponses = [
        "no response requested",
        "done",
        "ok",
        "okay",
        "complete",
        "finished",
      ];
      const isTrivial = !assistantText.trim() ||
        trivialResponses.some(t => assistantText.trim().toLowerCase().startsWith(t));

      if (isTrivial && (turn > 0 || toolsExecuted > 0)) {
        opts.onText?.("\n[Continuing — task may not be complete.]\n\n");
        conversation.push({
          role: "user",
          content: "You stopped after partial work. Please continue and complete the entire task I asked for. If there are more steps to run, run them now.",
        });
        continue;
      }

      if (!assistantText.trim() && turn === 0 && toolsExecuted === 0) {
        opts.onText?.("\n[Let me try that again.]\n\n");
        conversation.push({
          role: "user",
          content: "You returned an empty response. Please complete the task I asked for.",
        });
        continue;
      }

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
      toolsExecuted++;
    }
  }

  return conversation;
}

export { SYSTEM_PROMPT };
