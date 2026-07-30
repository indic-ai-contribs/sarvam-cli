// Sarvam native provider — backed by the official `sarvamai` SDK.
//
// The SDK (npm: sarvamai) handles auth, retries, SSE parsing, and SDK quirks
// (e.g. the content=null gotcha when reasoning consumes the token budget).
// We just drive `client.chat.completions({ stream: true })` and accumulate
// tool-call fragments — the same streaming shape as the OpenAI provider, but
// with native Sarvam extras: reasoning_content + reasoning_effort.
//
// Ref: https://docs.sarvam.ai/api/api-guides-tutorials/chat-completion/overview

import { SarvamAIClient } from "sarvamai";
import { Message, Provider, ToolDef, StreamCallbacks, ChatCompletionDelta, ToolCallParsed } from "../types.js";

export interface SarvamProviderOpts {
  apiKey: string;
  model?: string; // sarvam-105b (128K context) — sarvam-m is deprecated
}

export class SarvamProvider implements Provider {
  name = "sarvam";
  private client: SarvamAIClient;
  private model: string;

  constructor(opts: SarvamProviderOpts) {
    this.client = new SarvamAIClient({ apiSubscriptionKey: opts.apiKey });
    this.model = opts.model ?? "sarvam-105b";
  }

  async chatStream(
    messages: Message[],
    tools: ToolDef[],
    opts: { temperature?: number; reasoning_effort?: "low" | "medium" | "high" },
    cb: StreamCallbacks
  ): Promise<void> {
    // Build the request payload for the SDK.
    const request: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
    };
    if (tools.length) {
      request.tools = tools;
      request.tool_choice = "auto";
    }
    if (opts.reasoning_effort) {
      request.reasoning_effort = opts.reasoning_effort;
    }

    let stream: AsyncIterable<any>;
    try {
      stream = await this.client.chat.completions(request as any);
    } catch (err) {
      // The SDK throws SarvamAIError subclasses (ForbiddenError, BadRequestError, etc.)
      // with informative messages. We just surface them.
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes("403") || msg.toLowerCase().includes("forbidden")
        ? " — invalid or missing API key? Get one at https://dashboard.sarvam.ai"
        : "";
      cb.onError(new Error(`Sarvam SDK error: ${msg}${hint}`));
      return;
    }

    // Accumulate streamed tool-call fragments (same OpenAI streaming shape).
    const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {};
    let content = "";

    try {
      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;

        // Text content — note: content can be null when reasoning_effort
        // consumes the token budget (Sarvam SDK gotcha). Guard with ?? "".
        if (delta.content) {
          content += delta.content;
          cb.onDelta({ content: delta.content });
        }

        // Reasoning tokens — Sarvam-native. Surface as a special delta
        // so the UI can optionally render them (dimmed).
        if (delta.reasoning_content) {
          cb.onDelta({ content: "", reasoning_content: delta.reasoning_content });
        }

        // Tool call fragments.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallAcc[tc.index]) toolCallAcc[tc.index] = { args: "" };
            if (tc.id) toolCallAcc[tc.index].id = tc.id;
            if (tc.function?.name) toolCallAcc[tc.index].name = tc.function.name;
            if (tc.function?.arguments) {
              toolCallAcc[tc.index].args += tc.function.arguments;
              cb.onDelta({ tool_calls: [tc] });
            }
          }
        }
      }
    } catch (err) {
      cb.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const tool_calls: ToolCallParsed[] = Object.values(toolCallAcc)
      .filter((t) => t.name)
      .map((t) => ({
        id: t.id ?? `call_${Math.random().toString(36).slice(2)}`,
        name: t.name!,
        arguments: (() => { try { return JSON.parse(t.args || "{}"); } catch { return { _raw: t.args }; } })(),
      }));

    cb.onDone({ content, tool_calls });
  }
}
