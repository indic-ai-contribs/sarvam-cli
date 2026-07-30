// Interactive REPL UI — line-buffered prompt, streaming output, and
// approval prompts (y/n) before any side-effecting tool runs.

import * as readline from "node:readline";
import { Message, Provider } from "../types.js";
import { runAgent, SYSTEM_PROMPT } from "../agent/loop.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export interface ReplOpts {
  provider: Provider;
  cwd: string;
  temperature?: number;
  reasoning_effort?: "low" | "medium" | "high";
  approveMode?: "always" | "never";
}

export async function startRepl(opts: ReplOpts): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, (a) => r(a)));

  let history: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];

  console.log(`${DIM}sarvam-cli · provider=${opts.provider.name} · cwd=${opts.cwd}${RESET}`);
  console.log(`${DIM}Type your request. /exit to quit, /clear to reset history.${RESET}\n`);

  const approve = async (tool: string, summary: string, detail: string): Promise<boolean> => {
    if (opts.approveMode === "never") return true;
    if (opts.approveMode === "always") return true;
    console.log(`${YELLOW}▸ approve ${tool}: ${summary}${RESET}`);
    if (detail) console.log(`${DIM}${detail}${RESET}`);
    const ans = (await ask(`${YELLOW}proceed? [y/N] ${RESET}`)).toLowerCase();
    const ok = ans === "y" || ans === "yes";
    console.log(ok ? `${GREEN}✓ approved${RESET}` : `${DIM}✗ declined${RESET}`);
    return ok;
  };

  while (true) {
    const input = await ask(`${CYAN}❯ ${RESET}`);
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === "/exit" || trimmed === "/quit") break;
    if (trimmed === "/clear") {
      history = [{ role: "system", content: SYSTEM_PROMPT }];
      console.log(`${DIM}history cleared${RESET}\n`);
      continue;
    }

    try {
      process.stdout.write(DIM);
      history = await runAgent(history, trimmed, {
        provider: opts.provider,
        cwd: opts.cwd,
        approve,
        temperature: opts.temperature,
        reasoning_effort: opts.reasoning_effort,
        onText: (chunk) => {
          process.stdout.write(RESET + chunk);
        },
        onReasoning: (chunk) => {
          process.stdout.write(`\x1b[2;3m${chunk}\x1b[0m`);
        },
        onToolCall: (name, args) => {
          process.stdout.write(`\n${YELLOW}▸ ${name}(${JSON.stringify(args).slice(0, 120)})${RESET} `);
        },
        onToolResult: (name, result) => {
          const preview = result.split("\n").slice(0, 3).join("\n");
          process.stdout.write(`\n${DIM}${preview}${result.length > 200 ? "…" : ""}${RESET}`);
        },
      });
      process.stdout.write(`\n\n${RESET}`);
    } catch (err) {
      console.error(`\n${RESET}Error: ${(err as Error).message}\n`);
    }
  }

  rl.close();
  console.log(`${DIM}bye${RESET}`);
}

export async function runSinglePrompt(
  prompt: string,
  opts: ReplOpts
): Promise<void> {
  const history: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];

  const approve = async (tool: string, summary: string, _detail: string): Promise<boolean> => {
    if (opts.approveMode === "never") return true;
    console.log(`${YELLOW}▸ ${tool}: ${summary}${RESET}`);
    return true; // single-prompt mode auto-approves (use --approve to change)
  };

  try {
    await runAgent(history, prompt, {
      provider: opts.provider,
      cwd: opts.cwd,
      approve,
      temperature: opts.temperature,
      reasoning_effort: opts.reasoning_effort,
      onText: (chunk) => process.stdout.write(chunk),
      onToolCall: (name, args) => {
        console.log(`\n${YELLOW}▸ ${name}(${JSON.stringify(args).slice(0, 120)})${RESET}`);
      },
      onToolResult: (_name, result) => {
        const preview = result.split("\n").slice(0, 5).join("\n");
        console.log(`${DIM}${preview}${RESET}`);
      },
    });
    console.log("");
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
