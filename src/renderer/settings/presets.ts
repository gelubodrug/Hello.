/**
 * Known OpenAI-compatible servers, offered as starting points so the first run
 * is a click instead of a URL the user has to look up.
 *
 * A preset is copied into the form and then forgotten: nothing saved records
 * which one it came from, so the user stays free to point “OpenRouter” at a
 * proxy and no later screen may contradict them.
 *
 * Every `baseUrl` is what the provider's own documentation gives as an OpenAI
 * client's base URL — this app appends `/models` and `/chat/completions`, so an
 * extra or missing path segment breaks both. Two are not the obvious guess:
 * Groq serves its compatible API under `/openai/v1`, and DeepSeek's base has no
 * version segment at all.
 */
export interface EndpointPreset {
  /** List key only; never saved with a connection. */
  id: string;
  name: string;
  baseUrl: string;
  /** Local servers answer without one, so their key field starts empty. */
  requiresApiKey: boolean;
  /** Where the key comes from, or what to run to get the server listening. */
  hint: string;
  /**
   * One model id in this provider's shape, used as the Model field's
   * placeholder. It teaches the shape, not the choice: OpenRouter ids carry a
   * vendor prefix and a `:free` suffix that nothing else in the form hints at,
   * while a local server's are bare names. A retired id costs nothing — once
   * models load, the server's own list takes over.
   */
  exampleModel: string;
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    hint: 'Key from openrouter.ai/keys — many providers behind one account, including free models.',
    exampleModel: 'deepseek/deepseek-r1:free',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    hint: 'Key from platform.openai.com/api-keys.',
    exampleModel: 'gpt-4o-mini',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    hint: 'Key from console.groq.com/keys.',
    exampleModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
    hint: 'Key from platform.deepseek.com/api_keys.',
    exampleModel: 'deepseek-chat',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresApiKey: true,
    hint: 'Key from the API keys page in console.mistral.ai.',
    exampleModel: 'mistral-small-latest',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    requiresApiKey: true,
    hint: 'Key from the API keys page in api.together.ai.',
    exampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    hint: 'Runs on this Mac. Start it with ollama serve, then pull a model.',
    exampleModel: 'llama3.2',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    requiresApiKey: false,
    hint: "Runs on this Mac. Start the server from LM Studio's Developer tab.",
    exampleModel: 'qwen2.5-7b-instruct',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
    hint: 'Runs on this Mac. Start it with llama-server -m your-model.gguf.',
    exampleModel: 'your-model.gguf',
  },
];

/** The preset a URL currently matches, for the model placeholder and its hint. */
export function presetFor(endpointUrl: string): EndpointPreset | undefined {
  const identity = endpointUrl.trim().replace(/\/+$/, '').toLowerCase();
  return ENDPOINT_PRESETS.find(preset => preset.baseUrl.toLowerCase() === identity);
}

/** A name to offer when remembering a connection the presets do not cover. */
export function suggestedName(endpointUrl: string): string {
  const preset = presetFor(endpointUrl);
  if (preset) return preset.name;
  try {
    return new URL(endpointUrl).host;
  } catch {
    return '';
  }
}
