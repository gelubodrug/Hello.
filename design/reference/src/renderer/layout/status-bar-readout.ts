import type { RequestDiagnostic } from '../../shared/errors';
import type { StreamFailure } from '../state/conversations';
import type { Endpoint, Message, MessageMetrics, Model } from '../../shared/types';

export type StatusTone = 'idle' | 'busy' | 'ready' | 'error';

export interface StatusReadout {
  tone: StatusTone;
  latencyMs: number | null;
  modelName: string | null;
  tokensPerSec: number | null;
  detail: string | null;
}

export interface StatusReadoutSources {
  streamId: string | null;
  streamError: string | null;
  lastStreamFailure: StreamFailure | null;
  discovering: boolean;
  activeEndpointId: string | null;
  activeModelId: string | null;
  activeEndpoint: Endpoint | undefined;
  models: Model[] | undefined;
  streamingMessage: Message | null;
  lastAssistantMetrics: MessageMetrics | null;
  nowMs?: number;
}

function classifyError(message: string): string {
  const text = message.toLowerCase();

  if (text.includes('timeout')) {
    return 'Timeout';
  }
  if (text.includes('server') || text.includes('5')) {
    return 'Server error';
  }
  if (text.includes('protocol') || text.includes('malformed') || text.includes('parse')) {
    return 'Malformed response';
  }
  if (text.includes('network') || text.includes('connection')) {
    return 'Connection lost';
  }

  return 'Generation failed';
}

/**
 * The status code beats any reading of the message text: a gateway that
 * answers 502 with "Connection error." is not a lost connection, and the two
 * were indistinguishable while this line was guessing from words alone.
 */
export function classifyFailure(message: string, diagnostic?: RequestDiagnostic): string {
  // Only a rejection status names the failure. A 2xx that failed anyway — a
  // gateway answering HTML where a stream belongs — is described by what it
  // sent, not by the code it sent it under.
  if (diagnostic?.status !== undefined && diagnostic.status >= 400) {
    return `HTTP ${diagnostic.status}`;
  }
  return classifyError(message);
}

export function getStreamingAssistantMessage(
  messages: Message[] | undefined,
  streamId: string | null,
): Message | null {
  if (!streamId || !messages || messages.length === 0) {
    return null;
  }

  const lastMessage = messages[messages.length - 1];
  return lastMessage.role === 'assistant' ? lastMessage : null;
}

export function getLastAssistantMetrics(messages: Message[] | undefined): MessageMetrics | null {
  if (!messages) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.metrics) {
      return message.metrics;
    }
  }

  return null;
}

export function resolveModelName(
  activeModelId: string | null,
  models: Model[] | undefined,
): string | null {
  if (!activeModelId) {
    return null;
  }

  const model = models?.find((entry) => entry.id === activeModelId);
  return model?.displayName ?? activeModelId;
}

export function resolveLatencyMs(
  streamingMessage: Message | null,
  lastAssistantMetrics: MessageMetrics | null,
): number | null {
  if (typeof streamingMessage?.metrics?.ttftMs === 'number') {
    return streamingMessage.metrics.ttftMs;
  }

  if (typeof lastAssistantMetrics?.ttftMs === 'number') {
    return lastAssistantMetrics.ttftMs;
  }

  return null;
}

export function estimateStreamingTokensPerSec(message: Message, nowMs: number): number | null {
  if (typeof message.metrics?.tokensPerSec === 'number') {
    return message.metrics.tokensPerSec;
  }

  if (message.content.length === 0) {
    return null;
  }

  const elapsedMs = nowMs - message.createdAt;
  if (elapsedMs <= 0) {
    return null;
  }

  const estimatedTokens = message.content.length / 4;
  return estimatedTokens / (elapsedMs / 1000);
}

/** Derives the live status-bar readout from existing renderer store snapshots. */
export function deriveStatusReadout(sources: StatusReadoutSources): StatusReadout {
  const {
    streamId,
    streamError,
    lastStreamFailure,
    discovering,
    activeEndpointId,
    activeModelId,
    activeEndpoint,
    models,
    streamingMessage,
    lastAssistantMetrics,
    nowMs = Date.now(),
  } = sources;

  const modelName = resolveModelName(activeModelId, models);
  const latencyMs = resolveLatencyMs(streamingMessage, lastAssistantMetrics);

  if (streamError) {
    // The store sets both together on a stream error, but `streamError` also
    // covers failures with no request behind them; only pair them up when the
    // failure is demonstrably the same one.
    const sameFailure =
      lastStreamFailure?.kind === 'error' && lastStreamFailure.message === streamError;

    return {
      tone: 'error',
      latencyMs,
      modelName,
      tokensPerSec: null,
      detail: classifyFailure(streamError, sameFailure ? lastStreamFailure.diagnostic : undefined),
    };
  }

  if (lastStreamFailure?.kind === 'error') {
    return {
      tone: 'error',
      latencyMs,
      modelName,
      tokensPerSec: null,
      detail: classifyFailure(lastStreamFailure.message, lastStreamFailure.diagnostic),
    };
  }

  if (streamId && streamingMessage) {
    return {
      tone: 'busy',
      latencyMs,
      modelName,
      tokensPerSec: estimateStreamingTokensPerSec(streamingMessage, nowMs),
      detail: null,
    };
  }

  if (lastStreamFailure?.kind === 'aborted') {
    return {
      tone: 'idle',
      latencyMs,
      modelName,
      tokensPerSec: null,
      detail: 'Stopped',
    };
  }

  if (discovering) {
    return {
      tone: 'busy',
      latencyMs,
      modelName,
      tokensPerSec: null,
      detail: 'Discovering endpoints…',
    };
  }

  if (activeEndpointId) {
    // Three states, not two (DESIGNUIguide.md §State pills). An id whose
    // endpoint is not in the list yet means the list has not arrived — not
    // that the endpoint is gone. Latent today, because hydration only sets
    // the id once it has confirmed the endpoint is listed, but the branch
    // must not be the one that shouts.
    if (!activeEndpoint) {
      return {
        tone: 'busy',
        latencyMs,
        modelName,
        tokensPerSec: null,
        detail: 'Endpoint not listed yet',
      };
    }

    // Unverified is not unavailable. This said "Endpoint unavailable" in red
    // off the same `verifiedAt === null` that makes the greeting say
    // "verifying" in a neutral tone, and the two render side by side
    // (App.tsx). One encoding, and it is the greeting's.
    if (activeEndpoint.verifiedAt === null) {
      return {
        tone: 'busy',
        latencyMs,
        modelName,
        tokensPerSec: null,
        detail: 'Verifying endpoint…',
      };
    }

    // Not "Loading models…": `loadModels` writes nothing when it fails, so
    // that promised a progress the user might wait on forever. This says only
    // what is true — the list has not arrived — without claiming it is empty.
    if (models === undefined) {
      return {
        tone: 'busy',
        latencyMs,
        modelName,
        tokensPerSec: null,
        detail: 'Models not listed yet',
      };
    }

    if (models.length === 0) {
      return {
        tone: 'error',
        latencyMs,
        modelName,
        tokensPerSec: null,
        detail: 'No models',
      };
    }

    if (activeModelId) {
      return {
        tone: 'ready',
        latencyMs,
        modelName,
        tokensPerSec: null,
        detail: null,
      };
    }

    return {
      tone: 'idle',
      latencyMs,
      modelName: null,
      tokensPerSec: null,
      detail: 'Model available',
    };
  }

  return {
    tone: 'idle',
    latencyMs: null,
    modelName: null,
    tokensPerSec: null,
    detail: 'No endpoint',
  };
}
