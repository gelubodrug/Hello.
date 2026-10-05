import { useCallback, useEffect, useRef, useState } from 'react';
import { Blocks } from 'lucide-react';
import type {
  DiscoveredMcpServer,
  DiscoveredSkill,
  LibraryResource,
  McpServerStatus,
} from '../../shared/types';
import { api } from '../api';
import { MenuButton, type MenuItem } from '../ui/primitives';

const kindLabel = { skill: 'Skill', plugin: 'Plugin', mcp: 'MCP server' } as const;
const kindGroup = { skill: 'Skills', plugin: 'Plugins', mcp: 'MCP' } as const;
const key = (kind: string, name: string) => `${kind}|${name.trim().toLocaleLowerCase()}`;

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
  const [found, setFound] = useState<{ mcp: DiscoveredMcpServer[]; skills: DiscoveredSkill[] }>(
    { mcp: [], skills: [] },
  );
  const [pending, setPending] = useState<string[]>([]);
  const working = useRef(new Set<string>());
  // Optional while a renderer hot update runs against an older desktop preload,
  // exactly like the browser lifecycle listeners.
  const bridge = (api as Partial<typeof api>).extensions as Partial<typeof api.extensions> | undefined;
  const load = useCallback(() => {
    // Each call is optional on its own: a renderer hot update may run against a
    // preload that predates any one of them, and the composer must still work.
    void bridge?.list?.().then(setResources).catch(() => setResources([]));
    void bridge?.active?.(conversationId).then(setActive).catch(() => setActive([]));
    void bridge?.status?.().then(setServers).catch(() => setServers([]));
    // What the other agent tools on this Mac already have. Reading it here is
    // what makes this list the whole answer: nothing has to be imported in
    // Settings first to be usable in a chat.
    void bridge?.discover?.().then(setFound).catch(() => setFound({ mcp: [], skills: [] }));
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
  /** Turning on something Hello has never held: bring it in, then activate it,
   * so a single click means the same thing everywhere in this list. */
  const adopt = (kind: 'skill' | 'mcp', id: string) => {
    if (!bridge?.importDiscovered || !bridge.setActive || working.current.has(id)) return;
    working.current.add(id);
    setPending(current => [...current, id]);
    void bridge
      .importDiscovered(kind, id)
      .then(resource => bridge.setActive!(conversationId, resource.id, true))
      .then(setActive)
      .catch(onError)
      .finally(() => {
        working.current.delete(id);
        setPending(current => current.filter(item => item !== id));
        load();
      });
  };

  const held = new Set(resources.map(resource => key(resource.kind, resource.name)));
  const imported: MenuItem[] = resources.map(resource => {
    // A server that failed to start is dropped from the model's tools;
    // saying so here is the difference between quiet and silent.
    const failure = servers.find(item => item.id === resource.id && item.error)?.error;
    // Every tool a server offers is described to the model on every turn,
    // so a large one costs context before a word is written.
    const tools = servers.find(item => item.id === resource.id)?.tools.length ?? 0;
    const weight = tools >= 25 ? `${tools} tools — fills much of the context` : tools ? `${tools} tools` : '';
    return {
      id: resource.id,
      label: resource.name,
      detail: resource.state !== 'ready'
        ? `${kindLabel[resource.kind]} · needs attention in Settings`
        : failure && active.includes(resource.id)
          ? `${kindLabel[resource.kind]} · did not start: ${failure}`.slice(0, 96)
          : `${kindLabel[resource.kind]} · ${weight || resource.description}`.slice(0, 96),
      checked: active.includes(resource.id),
      disabled: resource.state !== 'ready' && !active.includes(resource.id),
      group: kindGroup[resource.kind],
      stayOpen: true,
      action: () => toggle(resource),
    };
  });
  const offered: MenuItem[] = [
    ...found.skills
      .filter(skill => !held.has(key('skill', skill.name)))
      .map(skill => ({
        id: `found:${skill.id}`,
        label: skill.name,
        detail: pending.includes(skill.id)
          ? 'Skill · turning on…'
          : `Skill · from ${skill.source}${skill.description ? ` · ${skill.description}` : ''}`.slice(0, 96),
        disabled: pending.includes(skill.id),
        group: kindGroup.skill,
        stayOpen: true,
        action: () => adopt('skill', skill.id),
      })),
    ...found.mcp
      .filter(server => !held.has(key('mcp', server.name)))
      .map(server => ({
        id: `found:${server.id}`,
        label: server.name,
        detail: server.unsupported
          ? `MCP server · ${server.unsupported}`.slice(0, 96)
          : pending.includes(server.id)
            ? 'MCP server · turning on…'
            : `MCP server · from ${server.source}`.slice(0, 96),
        disabled: !!server.unsupported || pending.includes(server.id),
        group: kindGroup.mcp,
        stayOpen: true,
        action: () => adopt('mcp', server.id),
      })),
  ];
  const items: MenuItem[] = imported.length || offered.length
    ? [
        ...imported,
        ...(offered.length
          ? [{ id: 'found', separator: true, label: 'Found on this Mac', disabled: true }, ...offered]
          : []),
        {
          id: 'note',
          separator: true,
          label: busy ? 'Changes apply to your next message' : 'Active only in this chat',
          disabled: true,
        },
      ]
    : [{ id: 'empty', label: 'Nothing to use yet', detail: 'No skills or MCP servers here, and none configured by the other agent tools on this Mac', disabled: true }];
  const count = resources.filter(resource => active.includes(resource.id)).length;
  const available = resources.length + offered.length;
  // A library with nothing turned on in this chat looks the same as an empty
  // one, and the model then has no skills. Say that there is something to use,
  // in the button's name and tooltip. No dot: it floated to the composer's
  // corner and opened this menu from there (user, 05.10: hide it).
  const waiting = !count && available;
  return (
    <MenuButton
      label={count ? `Extensions (${count} active)` : waiting ? `Extensions (${available} available, none on)` : 'Extensions'}
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
