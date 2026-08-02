# Contributing to sarvamai-cli

Thanks for your interest in contributing! This project is an open-source community effort — not affiliated with Sarvam AI. All contributions are welcome.

## Getting started

```bash
git clone https://github.com/indic-ai-contribs/sarvamai-cli.git
cd sarvamai-cli
npm install
npm run build
npm link          # makes `sarvam` available on PATH
```

Set your Sarvam API key:

```bash
sarvam --init     # or: export SARVAM_API_KEY="sk_..."
```

## Project structure

```
bin/sarvam.ts        CLI entrypoint — flag parsing, config, mode dispatch
src/
  config.ts          ~/.sarvam/config.json + env var resolution
  types.ts           Shared message/tool/provider types
  providers/
    sarvam.ts        Sarvam provider — backed by the sarvamai SDK
    openai.ts        OpenAI-compatible fallback provider
  tools/
    index.ts         Tool definitions + runtime with approval gating
  agent/
    loop.ts          Agent loop: stream → tool calls → results → repeat
  ui/
    repl.ts          Interactive REPL + single-prompt mode
  util/
    sse.ts           Async SSE parser (used by the OpenAI provider)
  index.ts           Public API exports
scripts/             Demo recording + architecture diagram generation
docs/                Generated assets (demo.gif, architecture SVGs)
```

## How to contribute

### Adding a new tool

1. Define a `ToolDef` (JSON Schema parameters) and a `run` function in `src/tools/index.ts`.
2. Register it in the `TOOLS` array at the bottom of the file.
3. The agent loop picks it up automatically — no other changes needed.

Tools that mutate state (write, edit, execute) should call `ctx.approve()` before running.

### Adding a new provider

1. Implement the `Provider` interface from `src/types.ts` (requires `name`, `getModel()`, `setModel()`, `chatStream()`).
2. Wire it in `buildProvider()` in `bin/sarvam.ts`.
3. Add it to the config type in `src/config.ts`.

### Fixing bugs

Check the [issues](https://github.com/indic-ai-contribs/sarvamai-cli/issues) tab for open bugs. If you find a bug that isn't filed, open an issue first, then submit a PR.

## Coding conventions

- **Zero runtime dependencies beyond `sarvamai`.** Use Node 20 built-ins (`fetch`, `readline`, `child_process`, `fs/promises`).
- **TypeScript strict mode.** `npm run build` must pass with zero errors.
- **No external CLI frameworks.** Flag parsing is hand-rolled in `bin/sarvam.ts`. Keep it simple.
- **MIT licensed.** All contributions must be MIT-compatible.

## Testing

Currently testing is manual — run the CLI against a real Sarvam API key and verify the tools work. A formal test suite is a welcome contribution.

## Pull request process

1. Fork the repo and create a feature branch (`git checkout -b fix/my-fix`).
2. Run `npm run build` to verify it compiles.
3. Test against the live API if your change affects tool calling or streaming.
4. Write a clear commit message. Reference any issue numbers.
5. Open a PR with a description of what changed and why.

## Code of conduct

Be respectful. Be helpful. This is a community project — everyone is welcome.
