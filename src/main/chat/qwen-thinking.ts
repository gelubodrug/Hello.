// Qwen's thinking switch, shared by Hello's own chat (pi-session.ts) and the
// CLIs it launches on the same connection (terminal/cli-workers.ts).

/** A server of the person's own: this Mac, a `.local` name, or a private address. */
export function ownServer(hostname: string): boolean {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$|\.(?:local|localhost)$/i
    .test(hostname);
}

/**
 * Whether a model takes Qwen's thinking switch, `chat_template_kwargs.enable_thinking`:
 * chosen in Settings, or on Auto a Qwen model on a server of the person's own —
 * the convention local servers honor (vLLM, SGLang, llama.cpp, MTPLX). Without
 * it Reasoning Off never reached the server, and the model thought at the
 * server's own level on every step (user, 29.09: 7,803 reasoning tokens, 157 s,
 * before one click; 30.09: "Claude in 10 seconds, the local model in 5 minutes").
 */
export function usesQwenThinkingSwitch(
  endpointUrl: string,
  model: string,
  compatibility: 'auto' | 'openai' | 'qwen-chat-template' = 'auto',
): boolean {
  if (compatibility === 'qwen-chat-template') return true;
  if (compatibility !== 'auto' || !/qwen/i.test(model)) return false;
  try {
    return ownServer(new URL(endpointUrl).hostname);
  } catch {
    return false;
  }
}
