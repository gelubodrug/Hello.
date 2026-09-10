import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand/react';

import { Reveal } from '../ui/Reveal';
import { TruncatedText } from '../ui/TruncatedText';
import { conversationsStore } from '../state/conversations';
import { endpointsStore } from '../state/endpoints';

import {
  deriveStatusReadout,
  getLastAssistantMetrics,
  getStreamingAssistantMessage,
} from './status-bar-readout';
import type { StatusReadout } from './status-bar-readout';
import styles from './StatusBar.module.css';

function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? '—' : `${latencyMs} ms`;
}

function formatModelName(modelName: string | null): string {
  return modelName ?? 'No model';
}

function formatTokensPerSec(tokensPerSec: number | null): string | null {
  if (tokensPerSec === null) {
    return null;
  }

  return `${tokensPerSec.toFixed(1)} tok/s`;
}

interface StatusLayer {
  id: number;
  key: string;
  readout: StatusReadout;
  active: boolean;
}

function readoutKey(readout: StatusReadout): string {
  return JSON.stringify([
    readout.tone,
    readout.latencyMs,
    readout.modelName,
    readout.tokensPerSec === null ? null : readout.tokensPerSec.toFixed(1),
    readout.detail,
  ]);
}

function StatusSnapshot({ readout, active }: { readout: StatusReadout; active: boolean }) {
  const throughput = formatTokensPerSec(readout.tokensPerSec);

  return (
    <div className={styles.snapshot} aria-hidden={active ? undefined : 'true'}>
      <span
        className={`${styles.dot} ${styles[readout.tone]}`}
        aria-hidden="true"
        title="Endpoint health"
      />
      <TruncatedText className={styles.metric} title="Endpoint latency">
        {formatLatency(readout.latencyMs)}
      </TruncatedText>
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>
      <TruncatedText className={`${styles.metric} ${styles.model}`} title="Active model">
        {formatModelName(readout.modelName)}
      </TruncatedText>
      {throughput ? (
        <>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          <TruncatedText
            className={`${styles.metric} ${styles.throughput}`}
            title="Generation throughput"
          >
            {throughput}
          </TruncatedText>
        </>
      ) : null}
      {readout.detail ? (
        <TruncatedText className={styles.detail}>· {readout.detail}</TruncatedText>
      ) : null}
    </div>
  );
}

/**
 * StatusBar (tasks T053 / T095): a low-profile strip at the bottom of the chat
 * region showing endpoint health, latency, active model, and live throughput
 * while a generation streams. All values are derived from existing renderer
 * stores — no polling loops.
 */
export function StatusBar() {
  const streamId = useStore(conversationsStore, (state) => state.streamId);
  const streamError = useStore(conversationsStore, (state) => state.streamError);
  const lastStreamFailure = useStore(conversationsStore, (state) => state.lastStreamFailure);
  const activeConversation = useStore(conversationsStore, (state) => state.activeConversation);

  const discovering = useStore(endpointsStore, (state) => state.discoveryPhase === 'discovering');
  const endpoints = useStore(endpointsStore, (state) => state.endpoints);
  const models = useStore(endpointsStore, (state) => state.models);
  const activeEndpointId = useStore(endpointsStore, (state) => state.activeEndpointId);
  const activeModelId = useStore(endpointsStore, (state) => state.activeModelId);

  const activeEndpoint = activeEndpointId
    ? endpoints.find((endpoint) => endpoint.id === activeEndpointId)
    : undefined;
  const endpointModels = activeEndpointId ? models[activeEndpointId] : undefined;
  const messages = activeConversation?.messages;
  const streamingMessage = getStreamingAssistantMessage(messages, streamId);
  const lastAssistantMetrics = getLastAssistantMetrics(messages);

  const readout = deriveStatusReadout({
    streamId,
    streamError,
    lastStreamFailure,
    discovering,
    activeEndpointId,
    activeModelId,
    activeEndpoint,
    models: endpointModels,
    streamingMessage,
    lastAssistantMetrics,
  });

  const nextKey = readoutKey(readout);
  const layerIdRef = useRef(1);
  const [layers, setLayers] = useState<StatusLayer[]>([
    { id: 0, key: nextKey, readout, active: true },
  ]);

  useEffect(() => {
    setLayers((current) => {
      if (current.some((layer) => layer.active && layer.key === nextKey)) {
        return current;
      }

      const nextLayer: StatusLayer = {
        id: layerIdRef.current,
        key: nextKey,
        readout,
        active: true,
      };
      layerIdRef.current += 1;
      return [...current.map((layer) => ({ ...layer, active: false })), nextLayer];
    });
  }, [nextKey, readout]);

  const removeLayer = useCallback((id: number) => {
    setLayers((current) => current.filter((layer) => layer.id !== id || layer.active));
  }, []);

  return (
    <footer className={styles.statusBar} role="status" aria-live="polite">
      <div className={styles.viewport}>
        {layers.map((layer) => (
          <Reveal
            key={layer.id}
            show={layer.active}
            duration="fast"
            className={styles.statusReadout}
            onExited={() => removeLayer(layer.id)}
          >
            <StatusSnapshot readout={layer.readout} active={layer.active} />
          </Reveal>
        ))}
      </div>
    </footer>
  );
}
