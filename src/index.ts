// Public API surface for programmatic use.
export { SarvamProvider } from "./providers/sarvam.js";
export { OpenAIProvider } from "./providers/openai.js";
export { runAgent, SYSTEM_PROMPT, AgentOpts } from "./agent/loop.js";
export { executeTool, TOOL_DEFS, ToolCtx } from "./tools/index.js";
export { loadConfig, saveConfig, Config } from "./config.js";
export * from "./types.js";
