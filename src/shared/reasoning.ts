// Qwen's thinking switch, and what a connection does with Low/Medium/High.
// Shared by the Pi launch config (main/chat/pi-session.ts), the CLIs Hello
// starts on the same connection (main/terminal/cli-workers.ts, through
// main/chat/qwen-thinking.ts) and Settings, which has to say the same thing
// the request does.

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

/**
 * How far Low/Medium/High travels on one connection:
 *
 * - `level` — the level itself reaches the server: `reasoning_effort` on an
 *   OpenAI-compatible server, `reasoning: { effort }` on OpenRouter.
 * - `switch` — only thinking on or off reaches it, never which level: Qwen's
 *   chat template sends `enable_thinking`, DeepSeek a `thinking` block.
 * - `nothing` — the request carries no reasoning field at all, so the server
 *   thinks at its own level whatever Settings says. Pi still reads the model's
 *   thinking blocks, which is why the chat looks as if thinking were on.
 *
 * These follow from the flags pi-session.ts declares to Pi and the branches Pi
 * takes on them (its openai-completions request builder): the level is sent
 * only where `supportsReasoningEffort` is declared, or where the provider's own
 * thinking format carries it. `nothing` is the case of MTPLX, Kimi's endpoint
 * and any other OpenAI-compatible server on Automatic — choosing
 * "OpenAI-compatible" in Settings moves it to `level`.
 */
export type ReasoningReach = 'level' | 'switch' | 'nothing';

export function reasoningReach(settings: {
  endpointUrl: string;
  model: string;
  modelCompatibility?: 'auto' | 'openai' | 'qwen-chat-template';
}): ReasoningReach {
  const compatibility = settings.modelCompatibility ?? 'auto';
  if (usesQwenThinkingSwitch(settings.endpointUrl, settings.model, compatibility)) return 'switch';
  if (compatibility === 'openai') return 'level';
  let hostname = '';
  try { hostname = new URL(settings.endpointUrl.replace(/\/chat\/completions$/, '')).hostname; } catch { return 'nothing'; }
  if (hostname === 'api.openai.com') return 'level';
  if (compatibility === 'auto' && hostname === 'openrouter.ai') return 'level';
  if (compatibility === 'auto' && hostname === 'api.deepseek.com') return 'switch';
  return 'nothing';
}

/** What Settings says under Reasoning effort, for the connection in the draft. */
export function reasoningNote(reach: ReasoningReach): string {
  if (reach === 'level') return 'This connection takes the level itself.';
  if (reach === 'switch') return 'This connection takes thinking on or off, not which level.';
  return 'This server is sent no reasoning setting at all: it thinks at its own level. Set Model compatibility to OpenAI-compatible to send the level.';
}
