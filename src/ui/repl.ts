// Interactive REPL UI — clean foreground (tool calls + output only),
// reasoning collected silently in background, toggle with Ctrl+O.
// /model switches models mid-session.

import * as readline from "node:readline";
import { Message, Provider } from "../types.js";
import { runAgent, buildSystemPrompt } from "../agent/loop.js";
import { SARVAM_MODELS } from "../providers/sarvam.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

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

  let history: Message[] = [{ role: "system", content: buildSystemPrompt(opts.cwd) }];

  // Background reasoning buffer
  let reasoningLog = "";
  let showReasoning = false;

  const printStatus = () => {
    const model = opts.provider.getModel();
    const reasoningStatus = showReasoning ? `${MAGENTA}on${RESET}` : `${DIM}off${RESET}`;
    console.log(`${DIM}sarvam-cli · ${opts.provider.name} · ${model} · ${opts.cwd}${RESET}`);
    console.log(`${DIM}exit to quit · clear to reset · Ctrl+O reasoning · /model to switch${RESET}`);
    console.log(`${DIM}reasoning: ${reasoningStatus}\n`);
  };

  printStatus();

  // Ctrl+O handler — toggle reasoning display
  // Ctrl+O sends \x0f (character code 15)
  process.stdin.on("data", (data) => {
    for (const byte of data) {
      if (byte === 0x0f) {
        showReasoning = !showReasoning;
        if (showReasoning) {
          process.stdout.write(`\r${MAGENTA}reasoning ON${RESET}  \n`);
        } else {
          process.stdout.write(`\r${DIM}reasoning OFF${RESET}  \n`);
        }
        // Re-print prompt
        process.stdout.write(`${CYAN}❯ ${RESET}`);
      }
    }
  });

  const approve = async (tool: string, summary: string, _detail: string): Promise<boolean> => {
    if (opts.approveMode === "never" || opts.approveMode === "always") return true;
    const label = summary.length > 60 ? summary.slice(0, 57) + "…" : summary;
    const ans = (await ask(`${YELLOW}▸ ${tool}: ${label} ${DIM}[y/N]${RESET} `)).toLowerCase().trim();
    return ans === "y" || ans === "yes";
  };

  while (true) {
    const input = await ask(`${CYAN}❯ ${RESET}`);
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "exit" || trimmed === "quit") break;

    // /model — switch model mid-session
    if (trimmed === "/model" || trimmed === "model") {
      const current = opts.provider.getModel();
      console.log(`${DIM}Current model: ${current}${RESET}`);

      if (opts.provider.name === "sarvam") {
        console.log(`${DIM}Available: ${SARVAM_MODELS.join(", ")}${RESET}`);
        const choice = (await ask(`${CYAN}model> ${RESET}`)).trim();
        if (choice) {
          opts.provider.setModel(choice);
          console.log(`${GREEN}✓ switched to ${opts.provider.getModel()}${RESET}\n`);
        } else {
          console.log(`${DIM}no change${RESET}\n`);
        }
      } else {
        const choice = (await ask(`${CYAN}model name> ${RESET}`)).trim();
        if (choice) {
          opts.provider.setModel(choice);
          console.log(`${GREEN}✓ switched to ${opts.provider.getModel()}${RESET}\n`);
        } else {
          console.log(`${DIM}no change${RESET}\n`);
        }
      }
      continue;
    }

    // /show — dump full reasoning log
    if (trimmed === "/show" || trimmed === "show reasoning") {
      if (reasoningLog.trim()) {
        console.log(`\n${MAGENTA}── Reasoning Log ──${RESET}`);
        console.log(`${DIM}${reasoningLog}${RESET}`);
        console.log(`${MAGENTA}── End ──${RESET}\n`);
      } else {
        console.log(`${DIM}No reasoning collected.${RESET}\n`);
      }
      continue;
    }

    if (trimmed === "/clear" || trimmed === "clear") {
      history = [{ role: "system", content: buildSystemPrompt(opts.cwd) }];
      reasoningLog = "";
      console.log(`${DIM}cleared${RESET}\n`);
      continue;
    }

    try {
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
          reasoningLog += chunk;
          if (showReasoning) {
            process.stdout.write(`\x1b[2;3m${chunk}\x1b[0m`);
          }
        },
        onToolCall: (name, args) => {
          const argPreview = JSON.stringify(args).slice(0, 80);
          process.stdout.write(`\n${DIM}▸ ${name}${argPreview !== "{}" ? ` ${argPreview}` : ""}${RESET}`);
        },
        onToolResult: (name, result) => {
          const lines = result.split("\n").filter((l) => !l.startsWith("[exit:"));
          const preview = lines.slice(0, 5).join("\n");
          if (preview.trim()) {
            process.stdout.write(`\n${DIM}${preview}${result.length > 300 ? "…" : ""}${RESET}`);
          }
        },
      });
      process.stdout.write(`\n\n${RESET}`);
    } catch (err) {
      console.error(`\n${RED}Error: ${(err as Error).message}${RESET}\n`);
    }
  }

  rl.close();
  console.log(`${DIM}bye${RESET}`);
}

export async function runSinglePrompt(
  prompt: string,
  opts: ReplOpts
): Promise<void> {
  const history: Message[] = [{ role: "system", content: buildSystemPrompt(opts.cwd) }];

  const approve = async (tool: string, summary: string, _detail: string): Promise<boolean> => {
    if (opts.approveMode === "never") return true;
    const label = summary.length > 60 ? summary.slice(0, 57) + "…" : summary;
    console.log(`${YELLOW}▸ ${tool}: ${label}${RESET}`);
    return true;
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
        const argPreview = JSON.stringify(args).slice(0, 80);
        process.stdout.write(`\n${DIM}▸ ${name}${argPreview !== "{}" ? ` ${argPreview}` : ""}${RESET}`);
      },
      onToolResult: (_name, result) => {
        const lines = result.split("\n").filter((l) => !l.startsWith("[exit:"));
        const preview = lines.slice(0, 5).join("\n");
        if (preview.trim()) {
          console.log(`${DIM}${preview}${RESET}`);
        }
      },
    });
    console.log("");
  } catch (err) {
    console.error(`\n${RED}Error: ${(err as Error).message}${RESET}`);
    process.exitCode = 1;
  }
}
