/**
 * Known OpenAI-compatible servers, offered as starting points for the endpoint
 * form so the first run is a click rather than a URL the user has to look up.
 *
 * A preset is copied into the form and then forgotten. Nothing about a saved
 * endpoint records which one it came from: the user is free to point
 * "OpenRouter" at a proxy, and no later screen may contradict them.
 *
 * Every `baseUrl` is the value the provider's own documentation gives for an
 * OpenAI client's `baseURL` — the app appends `/models` and `/chat/completions`
 * to it, so a wrong or extra path segment breaks both. Two of them are not the
 * obvious guess and are documented as such: Groq serves its compatible API
 * under `/openai/v1`, and DeepSeek's base carries no version segment at all.
 */
export interface EndpointPreset {
  /** List key only; never persisted with the endpoint. */
  id: string;
  displayName: string;
  baseUrl: string;
  /** Local servers accept requests without one, so their key field starts empty. */
  requiresApiKey: boolean;
  /** Where to get the key, or what to run to get the server listening. */
  hint: string;
  /**
   * One model id in the shape this provider uses, for the Model ID field's
   * placeholder. It teaches the shape, not the choice: OpenRouter's ids carry
   * a vendor prefix and a `:free` suffix that nothing else in the form hints
   * at, while a local server's are bare names. An id that is retired later
   * costs nothing — the field is optional, and once a probe has run the
   * placeholder gives way to the server's own list.
   */
  exampleModel: string;
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    hint: 'Key from openrouter.ai/keys — many providers behind one account.',
    exampleModel: 'deepseek/deepseek-r1:free',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    hint: 'Key from platform.openai.com/api-keys.',
    exampleModel: 'gpt-4o-mini',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    hint: 'Key from console.groq.com/keys.',
    exampleModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
    hint: 'Key from platform.deepseek.com/api_keys.',
    exampleModel: 'deepseek-chat',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresApiKey: true,
    hint: 'Key from the API keys page in console.mistral.ai.',
    exampleModel: 'mistral-small-latest',
  },
  {
    id: 'together',
    displayName: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    requiresApiKey: true,
    hint: 'Key from the API keys page in api.together.ai.',
    exampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    hint: 'Runs on this Mac. Start it with ollama serve, then pull a model.',
    exampleModel: 'llama3.2',
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    requiresApiKey: false,
    hint: "Runs on this Mac. Start the server from LM Studio's Developer tab.",
    exampleModel: 'qwen2.5-7b-instruct',
  },
  {
    id: 'llamacpp',
    displayName: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
    hint: 'Runs on this Mac. Start it with llama-server -m your-model.gguf.',
    exampleModel: 'your-model.gguf',
  },
];
