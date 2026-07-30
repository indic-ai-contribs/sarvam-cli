// OpenAI-compatible provider — works with any /v1/chat/completions endpoint:
// OpenAI, Groq, Together, Ollama (with OpenAI shim), LM Studio, etc.
// Sarvam itself is OpenAI-compatible in shape, so this also doubles as a
// Sarvam fallback if you only have Bearer auth available.

import { Message, Provider, ToolDef, StreamCallbacks, ChatCompletionDelta, ToolCallParsed } from "../types.js";
import { parseSSE } from "../util/sse.js";

export interface OpenAIProviderOpts {
  apiKey: string;
  model: string;
  baseUrl?: string; // e.g. https://api.openai.com/v1
}

export class OpenAIProvider implements Provider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: OpenAIProviderOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async chatStream(
    messages: Message[],
    tools: ToolDef[],
    opts: { temperature?: number },
    cb: StreamCallbacks
  ): Promise<void> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      cb.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      cb.onError(new Error(`OpenAI-compatible API ${res.status}: ${text.slice(0, 300)}`));
      return;
    }

    const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {};
    let content = "";

    try {
      for await (const event of parseSSE(res.body)) {
        if (event === "[DONE]") break;
        let json: any;
        try { json = JSON.parse(event); } catch { continue; }
        if (json.choices?.[0]?.delta) {
          const delta: ChatCompletionDelta = json.choices[0].delta;
          if (delta.content) {
            content += delta.content;
            cb.onDelta({ content: delta.content });
          }
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
