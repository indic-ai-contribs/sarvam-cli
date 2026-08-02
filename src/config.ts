// Config layer — reads ~/.sarvam/config.json and resolves the provider + API key.
// Resolution order: CLI flag > env var > config file.
//
// Example config:
// {
//   "provider": "sarvam",
//   "sarvam": { "apiKey": "sk_...", "model": "sarvam-105b" },
//   "openai": { "apiKey": "sk-...", "model": "gpt-4o", "baseUrl": "https://api.openai.com/v1" }
// }

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface Config {
  provider: "sarvam" | "openai";
  sarvam: { apiKey: string; model: string; baseUrl?: string };
  openai: { apiKey: string; model: string; baseUrl?: string };
  temperature?: number;
  reasoning_effort?: "low" | "medium" | "high";
  approve?: "always" | "never"; // default: prompt every time
}

const CONFIG_DIR = path.join(os.homedir(), ".sarvam");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export async function loadConfig(overrides?: Partial<Config>): Promise<Config> {
  let file: Partial<Config> = {};
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    file = JSON.parse(raw);
  } catch {
    // No config file — that's fine, we'll rely on env / overrides.
  }

  const provider = (overrides?.provider ??
    file.provider ??
    (process.env.SARVAM_API_KEY ? "sarvam" : process.env.OPENAI_API_KEY ? "openai" : "sarvam")) as Config["provider"];

  // Note: use || (not ??) so empty strings from a partial config file
  // fall through to env vars. ?? would keep "" and block the env fallback.
  const sarvamApiKey =
    overrides?.sarvam?.apiKey ||
    file.sarvam?.apiKey ||
    process.env.SARVAM_API_KEY ||
    "";

  const openaiApiKey =
    overrides?.openai?.apiKey ||
    file.openai?.apiKey ||
    process.env.OPENAI_API_KEY ||
    "";

  const cfg: Config = {
    provider,
    sarvam: {
      apiKey: sarvamApiKey,
      model: overrides?.sarvam?.model || file.sarvam?.model || "sarvam-105b",
      baseUrl: overrides?.sarvam?.baseUrl ?? file.sarvam?.baseUrl,
    },
    openai: {
      apiKey: openaiApiKey,
      model: overrides?.openai?.model || file.openai?.model || "gpt-4o",
      baseUrl: overrides?.openai?.baseUrl ?? file.openai?.baseUrl,
    },
    temperature: overrides?.temperature ?? file.temperature,
    reasoning_effort: overrides?.reasoning_effort ?? file.reasoning_effort,
    approve: overrides?.approve ?? file.approve,
  };

  return cfg;
}

export async function saveConfig(cfg: Config): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

export async function initConfigInteractive(): Promise<Config | null> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // readline never fires the question callback when the interface closes first
  // (Ctrl+D, Ctrl+C, or piped stdin running out of lines). Left unhandled the
  // awaited promise hangs forever, the event loop drains, and node exits with
  // status 0 having written nothing — reporting success while doing nothing.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const ask = (q: string): Promise<string | null> =>
    new Promise((resolve) => {
      if (closed) return resolve(null);
      let answered = false;
      const onClose = () => {
        if (!answered) {
          answered = true;
          resolve(null);
        }
      };
      rl.once("close", onClose);
      rl.question(q, (a) => {
        answered = true;
        rl.removeListener("close", onClose);
        resolve(a.trim());
      });
    });

  console.log("\n  sarvamai-cli init\n  ----------------\n");

  const questions = [
    "Provider [sarvam/openai] (default: sarvam): ",
    "Sarvam API key (sk_..., Enter to skip): ",
    "Sarvam model (default: sarvam-105b): ",
    "OpenAI-compatible API key (Enter to skip): ",
    "OpenAI model (default: gpt-4o): ",
  ];

  const answers: string[] = [];
  for (const q of questions) {
    const a = await ask(q);
    if (a === null) {
      rl.close();
      // Abort instead of saving what we collected. A partial config with an
      // empty apiKey silently shadows the env vars — that is exactly the bug
      // the || fallback above exists to work around. No write beats a bad one.
      console.error("\n  init aborted — input ended before every question was answered.");
      console.error(`  Nothing written to ${CONFIG_PATH}. Re-run \`sarvam --init\` on a terminal.\n`);
      return null;
    }
    answers.push(a);
  }

  rl.close();

  const [provider, sarvamKey, sarvamModel, openaiKey, openaiModel] = answers;

  const cfg: Config = {
    provider: provider === "openai" ? "openai" : "sarvam",
    sarvam: { apiKey: sarvamKey, model: sarvamModel || "sarvam-105b" },
    openai: { apiKey: openaiKey, model: openaiModel || "gpt-4o" },
  };

  await saveConfig(cfg);
  console.log(`\n  Saved to ${CONFIG_PATH}\n`);
  return cfg;
}
