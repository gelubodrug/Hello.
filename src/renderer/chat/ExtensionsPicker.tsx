import { useCallback, useEffect, useState } from 'react';
import { Blocks } from 'lucide-react';
import type { LibraryResource, McpServerStatus } from '../../shared/types';
import { api } from '../api';
import { MenuButton, type MenuItem } from '../ui/primitives';

const kindLabel = { skill: 'Skill', plugin: 'Plugin', mcp: 'MCP server' } as const;

/** Per-conversation activation. Selection applies from the next message on:
 * Hello restarts the chat runtime with exactly this set, keeping the history. */
export function ExtensionsPicker({
  conversationId,
  busy,
  onError,
}: {
  conversationId: string;
  busy: boolean;
  onError: (reason: unknown) => void;
}) {
  const [resources, setResources] = useState<LibraryResource[]>([]);
  const [active, setActive] = useState<string[]>([]);
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  // Optional while a renderer hot update runs against an older desktop preload,
  // exactly like the browser lifecycle listeners.
  const bridge = (api as Partial<typeof api>).extensions as Partial<typeof api.extensions> | undefined;
  const load = useCallback(() => {
    // Each call is optional on its own: a renderer hot update may run against a
    // preload that predates any one of them, and the composer must still work.
    void bridge?.list?.().then(setResources).catch(() => setResources([]));
    void bridge?.active?.(conversationId).then(setActive).catch(() => setActive([]));
    void bridge?.status?.().then(setServers).catch(() => setServers([]));
  }, [bridge, conversationId]);
  useEffect(() => {
    load();
    return bridge?.onChange?.(load);
  }, [bridge, load]);
  const toggle = (resource: LibraryResource) => {
    if (!bridge?.setActive) return;
    const next = !active.includes(resource.id);
    setActive(current => (next ? [...current, resource.id] : current.filter(id => id !== resource.id)));
    void bridge
      .setActive(conversationId, resource.id, next)
      .then(setActive)
      .catch(reason => { onError(reason); load(); });
  };
  const items: MenuItem[] = resources.length
    ? [
        ...resources.map(resource => {
          // A server that failed to start is dropped from the model's tools;
          // saying so here is the difference between quiet and silent.
          const failure = servers.find(item => item.id === resource.id && item.error)?.error;
          return {
            id: resource.id,
            label: resource.name,
            detail: resource.state !== 'ready'
              ? `${kindLabel[resource.kind]} · needs attention in Settings`
              : failure && active.includes(resource.id)
                ? `${kindLabel[resource.kind]} · did not start: ${failure}`.slice(0, 96)
                : `${kindLabel[resource.kind]} · ${resource.description}`.slice(0, 84),
            checked: active.includes(resource.id),
            disabled: resource.state !== 'ready' && !active.includes(resource.id),
            action: () => toggle(resource),
          };
        }),
        {
          id: 'note',
          separator: true,
          label: busy ? 'Changes apply to your next message' : 'Active only in this chat',
          disabled: true,
        },
      ]
    : [{ id: 'empty', label: 'No extensions imported yet', detail: 'Settings › Extensions', disabled: true }];
  const count = resources.filter(resource => active.includes(resource.id)).length;
  return (
    <MenuButton
      label={count ? `Extensions (${count} active)` : 'Extensions'}
      heading="Use in this chat"
      searchPlaceholder="search extensions"
      items={items}
      onOpen={load}
      className={`icon-button${count ? ' has-extensions' : ''}`}
    >
      <Blocks size={16} />
      {count > 0 && <span className="extension-count" aria-hidden>{count}</span>}
    </MenuButton>
  );
}
