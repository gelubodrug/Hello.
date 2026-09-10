import { useStore } from 'zustand/react';

import { endpointsStore } from '../state/endpoints';
import { Reveal } from '../ui/Reveal';

type EndpointHintTone = 'idle' | 'pending' | 'ready';

interface EndpointHint {
  tone: EndpointHintTone;
  text: string;
}

/**
 * Quiet endpoint-status line for the welcome screen. Mirrors the Titlebar's
 * verified-state-only rule (FR-003): an unverified endpoint or one without a
 * chosen model is never surfaced as if it were ready to chat.
 */
export function deriveEndpointHint(input: {
  discoveryPhase: string;
  endpointCount: number;
  activeEndpoint: { displayName: string; verifiedAt: number | null } | null;
  activeModelId: string | null;
}): EndpointHint {
  const { discoveryPhase, endpointCount, activeEndpoint, activeModelId } = input;

  if (discoveryPhase === 'discovering' && endpointCount === 0) {
    return { tone: 'pending', text: 'Looking for a local endpoint…' };
  }

  if (activeEndpoint === null) {
    return { tone: 'idle', text: 'No endpoint connected yet' };
  }

  if (activeEndpoint.verifiedAt === null) {
    return { tone: 'pending', text: `${activeEndpoint.displayName} · verifying` };
  }

  if (activeModelId === null) {
    return { tone: 'pending', text: `${activeEndpoint.displayName} · choose a model` };
  }

  return { tone: 'ready', text: `${activeEndpoint.displayName} · ${activeModelId}` };
}

/**
 * The empty state of DESIGNUIguide.md §Empty states: "Hello." plus the quiet
 * endpoint-status line, vertically centered above the docked composer.
 *
 * It serves two states that look identical to the user — no conversation at
 * all, and a conversation that holds no messages yet (T129) — so it lives here
 * rather than in App: MessageList renders it for the second case, which keeps
 * MessageList mounted from the moment a conversation is selected and therefore
 * keeps the first turn's append reveal (§Motion "Message append") intact.
 */
export function ConversationGreeting(): JSX.Element {
  const endpoints = useStore(endpointsStore, (s) => s.endpoints);
  const activeEndpointId = useStore(endpointsStore, (s) => s.activeEndpointId);
  const activeModelId = useStore(endpointsStore, (s) => s.activeModelId);
  const discoveryPhase = useStore(endpointsStore, (s) => s.discoveryPhase);

  const activeEndpoint =
    activeEndpointId !== null ? (endpoints.find((e) => e.id === activeEndpointId) ?? null) : null;

  const endpointHint = deriveEndpointHint({
    discoveryPhase,
    endpointCount: endpoints.length,
    activeEndpoint,
    activeModelId,
  });

  return (
    <div className="app-chat-empty" data-chat-surface>
      <div className="greeting" role="group" aria-label="Welcome">
        <Reveal as="h1" className="greeting-title" duration="slow">
          Hello.
        </Reveal>
        <p className="welcome-status">
          <span className="welcome-status-dot" data-tone={endpointHint.tone} aria-hidden="true" />
          {endpointHint.text}
        </p>
      </div>
    </div>
  );
}

export default ConversationGreeting;
