import { createStore } from 'zustand/vanilla';

import {
  CLI_WORKER_CATALOG,
  type CliWorker,
  type CliWorkerId,
  type TerminalApi,
} from '../../shared/ipc-contract';

const ENABLED_WORKERS_KEY = 'cli-workers:enabled';
const IDS = new Set<CliWorkerId>(CLI_WORKER_CATALOG.map((worker) => worker.id));

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readEnabledCliWorkers(
  source: Pick<Storage, 'getItem'> | null = storage(),
): Set<CliWorkerId> {
  try {
    const raw = source?.getItem(ENABLED_WORKERS_KEY);
    if (raw === null || raw === undefined) return new Set(IDS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(IDS);
    return new Set(
      parsed.filter(
        (id): id is CliWorkerId => typeof id === 'string' && IDS.has(id as CliWorkerId),
      ),
    );
  } catch {
    return new Set(IDS);
  }
}

export interface CliWorkersState {
  workers: CliWorker[];
  enabledIds: Set<CliWorkerId>;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  setEnabled(id: CliWorkerId, enabled: boolean): void;
}

function terminalApi(): Pick<TerminalApi, 'listCliWorkers'> | null {
  if (typeof window === 'undefined' || !('api' in window)) return null;
  return window.api.terminal ?? null;
}

export function createCliWorkersStore(
  api: Pick<TerminalApi, 'listCliWorkers'> | null = terminalApi(),
  persisted: Pick<Storage, 'getItem' | 'setItem'> | null = storage(),
) {
  return createStore<CliWorkersState>()((set, get) => ({
    workers: CLI_WORKER_CATALOG.map((worker) => ({ ...worker, installed: false })),
    enabledIds: readEnabledCliWorkers(persisted),
    loading: true,
    error: null,

    async refresh(): Promise<void> {
      if (!api) {
        set({ loading: false });
        return;
      }
      const result = await api.listCliWorkers();
      if (!result.ok) {
        set({ loading: false, error: result.error.message });
        return;
      }
      const installed = new Set(result.value.map((worker) => worker.id));
      set({
        workers: CLI_WORKER_CATALOG.map((worker) => ({
          ...worker,
          installed: installed.has(worker.id),
        })),
        loading: false,
        error: null,
      });
    },

    setEnabled(id, enabled): void {
      const next = new Set(get().enabledIds);
      if (enabled) next.add(id);
      else next.delete(id);
      set({ enabledIds: next });
      try {
        persisted?.setItem(ENABLED_WORKERS_KEY, JSON.stringify([...next]));
      } catch {
        // The in-memory selection remains valid when storage is unavailable.
      }
    },
  }));
}

export const cliWorkersStore = createCliWorkersStore();
