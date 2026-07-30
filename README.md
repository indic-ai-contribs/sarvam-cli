# sarvam-cli

An open-source agentic CLI coding assistant powered by **Sarvam AI**, built on the official [`sarvamai`](https://www.npmjs.com/package/sarvamai) SDK, with an OpenAI-compatible fallback provider. It reads, writes, and edits files and runs shell commands in your project — with your approval before any side effect.

Think of it as a lightweight, hackable terminal agent that talks to Sarvam's Indic-first LLMs (`sarvam-m`, `sarvam-30b`, `sarvam-105b`) via the official SDK, and degrades gracefully to any OpenAI-compatible endpoint as a fallback. MIT-licensed, designed to complement Sarvam's SDK + skills ecosystem and be adoptable upstream.

## Why

Sarvam ships an excellent SDK (`sarvamai` on npm/PyPI) and Agent Skills for hosted editors (Claude Code, Cursor, Windsurf). But there's no standalone terminal agent for developers who live in the CLI. `sarvam-cli` fills that gap — it consumes the official SDK for auth, retries, streaming, and SDK quirks, then layers an agentic tool loop on top.

**Relationship to Sarvam's stack:**

| Layer | What | Example |
|-------|------|---------|
| API client / SDK | `sarvamai` (official) | `npm install sarvamai` |
| Framework provider | Vercel AI SDK provider | `sarvam-ai-sdk` |
| Skills for hosted editors | `sarvamai/skills` (official) | Claude Code, Cursor |
| **Standalone terminal agent** | **sarvam-cli (this project)** | — |

## What's new in v0.2.0

- **Now backed by the official `sarvamai` SDK** — no more hand-rolled fetch. The SDK handles auth, retries, SSE parsing, and SDK quirks (like the `content=null` gotcha when reasoning consumes the token budget).
- **Reasoning token streaming** — Sarvam's `reasoning_content` deltas are now surfaced live in the REPL (dimmed/italic), so you can see the model thinking when `--reasoning-effort` is set.
- Cleaner provider separation: the Sarvam provider is thin (SDK-backed), the OpenAI provider remains raw-fetch for maximum compatibility.

## Install

```bash
git clone https://github.com/indic-ai-contribs/sarvam-cli.git
cd sarvam-cli
npm install        # installs sarvamai + typescript
npm run build
npm link           # makes `sarvam` available on your PATH
```

Then get a Sarvam API key from <https://dashboard.sarvam.ai> and run:

```bash
sarvam --init
```

This writes `~/.sarvam/config.json`:

```json
{
  "provider": "sarvam",
  "sarvam": { "apiKey": "sk_...", "model": "sarvam-m" },
  "openai": { "apiKey": "", "model": "gpt-4o" }
}
```

Alternatively, set environment variables:

```bash
export SARVAM_API_KEY="sk_..."
# or, for the OpenAI-compatible fallback
export OPENAI_API_KEY="sk-..."
```

## Usage

Interactive REPL:

```bash
sarvam
```

Single prompt (non-interactive):

```bash
sarvam "add a .gitignore for a Python project"
sarvam "find and fix the off-by-one in src/parser.ts"
```

Force a provider / model:

```bash
sarvam --provider openai --model gpt-4o "refactor utils.ts"
sarvam -p sarvam -m sarvam-105b "write a test for the auth flow"
```

Auto-approve all tool calls (use with care):

```bash
sarvam --approve never "run the tests and report failures"
```

Sarvam-native reasoning effort (streams thinking tokens in the REPL):

```bash
sarvam --reasoning-effort high "design a rate-limiter for this API"
```

All flags:

```
  -p, --provider <name>           sarvam | openai
  -m, --model <name>              Model name (sarvam-m, sarvam-30b, sarvam-105b, gpt-4o, ...)
      --base-url <url>            Override the API base URL (OpenAI provider only)
      --approve <mode>            always | never  (default: prompt each time)
  -t, --temperature <n>           Sampling temperature (0–2)
      --reasoning-effort <lvl>    low | medium | high  (Sarvam only)
      --init                      Create ~/.sarvam/config.json interactively
  -h, --help                      Show help
```

## Tools

The agent has four tools, all with approval prompts before any mutation:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file (with line numbers, offset/limit paging) |
| `write_file` | Write/overwrite a file (creates parent dirs) |
| `patch` | Targeted find-and-replace edit on a file |
| `run_shell` | Run a shell command, return stdout+stderr |

## Architecture

```
bin/sarvam.ts        CLI entrypoint — flag parsing, config loading, mode dispatch
src/
  config.ts          ~/.sarvam/config.json + env var resolution
  types.ts           Shared message/tool/provider types
  providers/
    sarvam.ts        Sarvam provider — backed by the official sarvamai SDK
    openai.ts        OpenAI-compatible provider — raw fetch + SSE, works with any /v1 endpoint
  tools/
    index.ts         Tool definitions + runtime with approval gating
  agent/
    loop.ts          Agent loop: stream → tool calls → results → repeat
  ui/
    repl.ts          Interactive REPL + single-prompt mode with streaming
  util/
    sse.ts           Minimal async SSE parser (used by the OpenAI provider)
```

**Runtime dependencies:** `sarvamai` (the official Sarvam SDK). The OpenAI provider uses Node 20's built-in `fetch` — no additional dependencies.

### Why two providers?

The **Sarvam provider** uses `SarvamAIClient` from the official `sarvamai` package. This gives us:
- Correct auth via `apiSubscriptionKey` (the SDK handles the header)
- Built-in retries and error handling (SDK throws typed `SarvamAIError` subclasses)
- Proper SSE stream parsing (SDK returns an `AsyncIterable<ChatCompletionChunk>`)
- Access to Sarvam-native extras: `reasoning_effort`, `reasoning_content`, `wiki_grounding`

The **OpenAI provider** is a thin raw-fetch client that works with any OpenAI-compatible endpoint (OpenAI, Groq, Together, Ollama, LM Studio). It exists as a fallback for users who don't have a Sarvam key yet or want to use a different model.

## Programmatic use

```typescript
import { SarvamProvider, runAgent } from "sarvam-cli";

const provider = new SarvamProvider({ apiKey: process.env.SARVAM_API_KEY! });
const history = await runAgent([], "list files in the current directory", {
  provider,
  cwd: ".",
  approve: async () => true,
  onText: (chunk) => process.stdout.write(chunk),
  onReasoning: (chunk) => process.stderr.write(`[thinking] ${chunk}`),
});
```

## Config resolution order

1. CLI flags (`--provider`, `--model`, etc.)
2. Environment variables (`SARVAM_API_KEY`, `OPENAI_API_KEY`)
3. `~/.sarvam/config.json`

## Notes on the Sarvam SDK

- Package: `npm install sarvamai` (v1.1.7+)
- Client: `new SarvamAIClient({ apiSubscriptionKey: "sk_..." })`
- Chat: `client.chat.completions({ model, messages, stream: true, tools })`
- Streaming returns `AsyncIterable<ChatCompletionChunk>` — each chunk has `choices[0].delta`
- `delta.content` can be `null` when reasoning consumes the token budget — the provider guards for this
- `delta.reasoning_content` carries thinking tokens (Sarvam-native) — surfaced in the REPL
- Auth failures throw `ForbiddenError` (Sarvam returns 403, not 401)

## Contributing

PRs welcome. This is an open-source community project — see `AUTHORS` for contributors. The goal is a clean, ecosystem-aligned codebase that Sarvam (or anyone) can adopt or fork.

To add a new tool: add a handler in `src/tools/index.ts` (a `ToolDef` + `run` function), then register it in the `TOOLS` array. The agent loop picks it up automatically.

To add a new provider: implement the `Provider` interface in `src/types.ts`, then wire it in `bin/sarvam.ts`'s `buildProvider`.

## License

MIT — see [LICENSE](LICENSE).
