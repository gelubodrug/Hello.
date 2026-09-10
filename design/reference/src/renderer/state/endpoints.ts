import { createStore } from 'zustand/vanilla';

import type { Result } from '../../shared/errors';
import type { Api } from '../../shared/ipc-contract';
import type { Endpoint, Model } from '../../shared/types';

export type DiscoveryPhase = 'idle' | 'discovering' | 'done' | 'error';

export interface EndpointsState {
  endpoints: Endpoint[];
  models: Record<string, Model[]>;
  activeEndpointId: string | null;
  activeModelId: string | null;
  discoveryPhase: DiscoveryPhase;
  lastError: string | null;

  refresh(): Promise<void>;
  discover(): Promise<void>;
  setActiveEndpoint(id: string): Promise<void>;
  setActiveModel(endpointId: string, modelId: string): Promise<void>;
  loadModels(endpointId: string): Promise<void>;
  /**
   * Pulls a just-saved endpoint into the UI: re-reads the list (so the new row
   * and its fresh `verifiedAt` show up), makes it the active endpoint, and
   * selects `modelId` when one was given. Without this the dialog writes to
   * disk and the toolbar keeps reporting "No endpoint".
   */
  adoptEndpoint(endpointId: string, modelId?: string): Promise<void>;
  /**
   * Deletes an endpoint and puts the window back in step with the config.
   *
   * The dialog used to call the IPC channel itself, which left every list in
   * the window still showing the row — and, when the deleted endpoint was the
   * active one, still claiming the app could send to it, while main had
   * already cleared the selection.
   */
  removeEndpoint(id: string): Promise<Result<void>>;
}

type EndpointsStore = ReturnType<typeof createEndpointsStore>;
type EndpointsIpcApi = Pick<Api, 'endpoints' | 'models'>;

function getEndpointsApi(): EndpointsIpcApi | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }

  return { endpoints: window.api.endpoints, models: window.api.models };
}

export function createEndpointsStore(api: EndpointsIpcApi | null = getEndpointsApi()) {
  const store = createStore<EndpointsState>()((set, get) => ({
    endpoints: [],
    models: {},
    activeEndpointId: null,
    activeModelId: null,
    discoveryPhase: 'idle',
    lastError: null,

    async refresh() {
      if (!api) {
        return;
      }

      const result = await api.endpoints.listEndpoints();
      if (result.ok) {
        set({ endpoints: result.value });
      }
    },

    async discover() {
      if (!api) {
        return;
      }

      set({ discoveryPhase: 'discovering', lastError: null });

      const result = await api.endpoints.discoverEndpoints();
      if (result.ok) {
        set({ endpoints: result.value.endpoints, discoveryPhase: 'done' });
      } else {
        set({ discoveryPhase: 'error', lastError: result.error.message });
      }
    },

    async setActiveEndpoint(id) {
      if (!api) {
        return;
      }

      const result = await api.endpoints.setActiveEndpoint(id);
      if (result.ok) {
        set({ activeEndpointId: id });
        await get().loadModels(id);
      }
    },

    async setActiveModel(endpointId, modelId) {
      if (!api) {
        return;
      }

      const result = await api.models.setActiveModel(endpointId, modelId);
      if (result.ok) {
        set({ activeEndpointId: endpointId, activeModelId: modelId });
      }
    },

    async adoptEndpoint(endpointId, modelId) {
      if (!api) {
        return;
      }

      await get().refresh();
      await api.endpoints.setActiveEndpoint(endpointId);
      set({ activeEndpointId: endpointId, activeModelId: null });
      await get().loadModels(endpointId);

      if (modelId !== undefined && modelId !== '') {
        await get().setActiveModel(endpointId, modelId);
      }
    },

    async removeEndpoint(id) {
      if (!api) {
        return {
          ok: false,
          error: { type: 'internal', message: 'No endpoint API in this window.' },
        };
      }

      const result = await api.endpoints.removeEndpoint(id);
      if (!result.ok) {
        return result;
      }

      await get().refresh();
      set((state) => {
        const { [id]: _removed, ...models } = state.models;
        return state.activeEndpointId === id
          ? { models, activeEndpointId: null, activeModelId: null }
          : { models };
      });

      return result;
    },

    async loadModels(endpointId) {
      if (!api) {
        return;
      }

      const result = await api.models.listModels(endpointId);
      if (result.ok) {
        set((state) => ({ models: { ...state.models, [endpointId]: result.value } }));
      }
    },
  }));

  void hydrateEndpointsStore(store, api);

  return store;
}

async function hydrateEndpointsStore(store: EndpointsStore, api: EndpointsIpcApi | null): Promise<void> {
  if (!api) {
    return;
  }

  await store.getState().refresh();

  if (store.getState().endpoints.length === 0) {
    await store.getState().discover();
  }

  // Restore the endpoint/model the user last chose; the config keeps it, but
  // nothing read it back, so every relaunch started on "No endpoint".
  const selection = await api.endpoints.getActiveSelection();
  if (!selection.ok || selection.value.endpointId === null) {
    return;
  }

  const { endpointId, modelId } = selection.value;
  if (!store.getState().endpoints.some((endpoint) => endpoint.id === endpointId)) {
    return;
  }

  store.setState({ activeEndpointId: endpointId, activeModelId: modelId });
  await store.getState().loadModels(endpointId);
}

export const endpointsStore = createEndpointsStore();

declare global {
  interface Window {
    api: Api;
  }
}
