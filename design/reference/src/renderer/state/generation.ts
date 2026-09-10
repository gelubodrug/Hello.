import { createStore } from 'zustand/vanilla';

export type GenerationPhase = 'idle' | 'starting' | 'streaming' | 'stopping' | 'error';

export interface GenerationState {
  phase: GenerationPhase;
  streamId: string | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  lastError: string | null;

  starting: () => void;
  streaming: (streamId: string) => void;
  updateMetrics: (patch: {
    ttftMs?: number;
    tokensPerSec?: number;
    promptTokens?: number;
    completionTokens?: number;
  }) => void;
  stopping: () => void;
  finished: () => void;
  aborted: () => void;
  errored: (message: string) => void;
  reset: () => void;
}

export function createGenerationStore() {
  return createStore<GenerationState>()((set) => ({
    phase: 'idle',
    streamId: null,
    ttftMs: null,
    tokensPerSec: null,
    promptTokens: null,
    completionTokens: null,
    lastError: null,

    starting: () => set({ phase: 'starting', streamId: null, lastError: null }),
    streaming: (streamId) => set({ phase: 'streaming', streamId }),
    updateMetrics: (patch) => set(patch),
    stopping: () => set({ phase: 'stopping' }),
    finished: () => set({ phase: 'idle', streamId: null }),
    aborted: () => set({ phase: 'idle', streamId: null }),
    errored: (message) => set({ phase: 'error', lastError: message }),
    reset: () =>
      set({
        phase: 'idle',
        streamId: null,
        ttftMs: null,
        tokensPerSec: null,
        promptTokens: null,
        completionTokens: null,
        lastError: null,
      }),
  }));
}
