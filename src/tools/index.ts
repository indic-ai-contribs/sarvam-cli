// Tool definitions + runtime. Each tool is a function that takes parsed
// arguments and returns a string result (for the model). Side-effecting tools
// (write_file, patch, run_shell) are gated behind an approval callback so the
// REPL can prompt y/n before executing — Claude-Code style.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ToolDef } from "../types.js";

export type ApprovalFn = (toolName: string, summary: string, detail: string) => Promise<boolean>;

export interface ToolCtx {
  cwd: string;
  approve: ApprovalFn;
}

export interface ToolHandler {
  def: ToolDef;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string>;
}

// ---------- read_file ----------
const readFileDef: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read the contents of a file relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute path to the file." },
        offset: { type: "integer", description: "1-based line to start reading from.", default: 1 },
        limit: { type: "integer", description: "Max number of lines to return.", default: 500 },
      },
      required: ["path"],
    },
  },
};

async function readFileRun(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const p = String(args.path);
  const abs = path.resolve(ctx.cwd, p);
  const offset = Number(args.offset ?? 1);
  const limit = Number(args.limit ?? 500);

  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(abs);
      const listing = entries.slice(0, 50).join("\n");
      return `Error: ${p} is a directory, not a file. Use run_shell with "ls -la ${p}" to list its contents.\n\nDirectory contents:\n${listing}${entries.length > 50 ? `\n…(${entries.length - 50} more)` : ""}`;
    }

    const content = await fs.readFile(abs, "utf8");
    const lines = content.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}|${l}`).join("\n");
    return numbered || "(empty file)";
  } catch (err) {
    return `Error reading ${p}: ${(err as Error).message}`;
  }
}

// ---------- write_file ----------
const writeFileDef: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write content to a file, creating it (and parent dirs) if needed. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute path to write." },
        content: { type: "string", description: "Full content to write." },
      },
      required: ["path", "content"],
    },
  },
};

async function writeFileRun(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const p = String(args.path);
  const content = String(args.content);
  const abs = path.resolve(ctx.cwd, p);
  const preview = content.length > 200 ? content.slice(0, 200) + `… (+${content.length - 200} chars)` : content;

  const ok = await ctx.approve(
    "write_file",
    `Write ${content.length} bytes to ${p}`,
    preview
  );
  if (!ok) return "User declined write_file.";

  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `Wrote ${content.length} bytes to ${p}.`;
  } catch (err) {
    return `Error writing ${p}: ${(err as Error).message}`;
  }
}

// ---------- patch ----------
const patchDef: ToolDef = {
  type: "function",
  function: {
    name: "patch",
    description: "Find-and-replace a single occurrence of `old` with `new` inside a file. The old string must match exactly.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to find." },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

async function patchRun(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const p = String(args.path);
  const oldStr = String(args.old_string);
  const newStr = String(args.new_string);
  const abs = path.resolve(ctx.cwd, p);

  let original: string;
  try {
    original = await fs.readFile(abs, "utf8");
  } catch (err) {
    return `Error reading ${p}: ${(err as Error).message}`;
  }

  const count = original.split(oldStr).length - 1;
  if (count === 0) return `Error: old_string not found in ${p}.`;
  if (count > 1) return `Error: old_string appears ${count} times in ${p}; make it unique.`;

  const ok = await ctx.approve(
    "patch",
    `Patch ${p}: replace ${oldStr.length} chars with ${newStr.length} chars`,
    `--- ${p}\n- ${oldStr.slice(0, 150)}\n+ ${newStr.slice(0, 150)}`
  );
  if (!ok) return "User declined patch.";

  try {
    const updated = original.replace(oldStr, newStr);
    await fs.writeFile(abs, updated, "utf8");
    return `Patched ${p} (1 replacement).`;
  } catch (err) {
    return `Error patching ${p}: ${(err as Error).message}`;
  }
}

// ---------- run_shell ----------
const runShellDef: ToolDef = {
  type: "function",
  function: {
    name: "run_shell",
    description: "Run a shell command in the project directory. Output (stdout+stderr, truncated to 8000 chars) is returned.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
      },
      required: ["command"],
    },
  },
};

async function runShellRun(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const command = String(args.command);

  const ok = await ctx.approve(
    "run_shell",
    command,
    ""
  );
  if (!ok) return "User declined run_shell.";

  return new Promise((resolve) => {
    const child = spawn(command, { cwd: ctx.cwd, shell: true, env: process.env });
    let out = "";
    const cap = 8000;

    const append = (data: Buffer | string) => {
      if (out.length < cap) out += data.toString().slice(0, cap - out.length);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      resolve(`${out}${out.length >= cap ? "\n…(truncated)" : ""}${code !== 0 ? `\n[exit: ${code}]` : ""}`);
    });
    child.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

// ---------- registry ----------
export const TOOLS: ToolHandler[] = [
  { def: readFileDef, run: readFileRun },
  { def: writeFileDef, run: writeFileRun },
  { def: patchDef, run: patchRun },
  { def: runShellDef, run: runShellRun },
];

export const TOOL_DEFS: ToolDef[] = TOOLS.map((t) => t.def);

// Aliases: models sometimes guess tool names. Map common guesses to real tools.
const TOOL_ALIASES: Record<string, string> = {
  bash: "run_shell",
  shell: "run_shell",
  exec: "run_shell",
  execute: "run_shell",
  cmd: "run_shell",
  command: "run_shell",
  terminal: "run_shell",
  read: "read_file",
  cat: "read_file",
  file: "read_file",
  write: "write_file",
  create_file: "write_file",
  edit: "patch",
  replace: "patch",
  find_replace: "patch",
  sed: "patch",
};

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx
): Promise<string> {
  // Resolve alias → canonical tool name
  const canonical = TOOL_ALIASES[name] ?? name;
  const handler = TOOLS.find((t) => t.def.function.name === canonical);
  if (!handler) return `Unknown tool: ${name}. Available tools: read_file, write_file, patch, run_shell.`;
  return handler.run(args, ctx);
}
