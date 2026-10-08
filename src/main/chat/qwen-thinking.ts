// Qwen's thinking switch, shared by Hello's own chat (pi-session.ts) and the
// CLIs it launches on the same connection (terminal/cli-workers.ts). The rules
// live in src/shared so Settings can say what the request does (reasoning.ts).
export { ownServer, usesQwenThinkingSwitch } from '../../shared/reasoning';
