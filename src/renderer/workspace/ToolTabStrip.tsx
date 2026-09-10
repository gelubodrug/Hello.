import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, FolderOpen, Globe, Terminal, X } from 'lucide-react';
import type { BrowserTab, TerminalSession } from '../../shared/types';
import type { FilesTab } from '../../shared/files';
import { ContextMenu, Truncated } from '../ui/primitives';

type Tool = BrowserTab | TerminalSession | FilesTab;

/** Tabs share the available width, down to one icon each. Only once the icon
 * budget is exhausted does the strip scroll; pane actions never shrink. */
export function ToolTabStrip({ tools, selectedId, onSelect, onClose }: {
  tools: Tool[]; selectedId?: string; onSelect: (id: string) => void; onClose: (tool: Tool) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuTool = tools.find(tool => tool.id === menu?.id);
  useEffect(() => { if (menu && !menuTool) setMenu(null); }, [menu, menuTool]);
  useLayoutEffect(() => {
    const node = strip.current;
    if (!node) return;
    const revealSelected = () => {
      const selected = node.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.parentElement;
      if (!selected) return;
      const bounds = node.getBoundingClientRect(), tab = selected.getBoundingClientRect();
      if (tab.left < bounds.left) node.scrollLeft -= bounds.left - tab.left;
      else if (tab.right > bounds.right) node.scrollLeft += tab.right - bounds.right;
    };
    revealSelected();
    const resize = new ResizeObserver(revealSelected);
    resize.observe(node);
    return () => resize.disconnect();
  }, [selectedId, tools.length]);
  return <>
    <div ref={strip} className="pills tool-tabs" role="tablist" aria-label="Tools">
      {tools.map((tool, index) => {
        const title = tool.title || ('url' in tool ? 'New tab' : 'Terminal');
        const ended = 'status' in tool && tool.status === 'exited';
        return <div className="tab-pill tool-tab" key={tool.id} data-tool-id={tool.id}
          data-active={selectedId === tool.id} title={`${title}${ended ? ' — Session ended' : ''}`}
          onContextMenu={event => { event.preventDefault(); setMenu({ id: tool.id, x: event.clientX, y: event.clientY }); }}>
          <button type="button" role="tab" aria-label={title} aria-selected={selectedId === tool.id}
            aria-controls={`tool-host-${tool.id}`} tabIndex={selectedId === tool.id ? 0 : -1}
            onClick={() => onSelect(tool.id)}
            onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tool); } }}
            onKeyDown={event => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tools.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + tools.length) % tools.length;
                onSelect(tools[next].id);
                strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
              } else if (event.key === 'Delete') {
                event.preventDefault(); onClose(tool);
              } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ id: tool.id, x: rect.left, y: rect.bottom });
              }
            }}>
            {'url' in tool ? <Globe size={14} /> : tool.kind === 'files' ? <FolderOpen size={14} /> : tool.kind === 'worker' ? <Bot size={14} /> : <Terminal size={14} />}
            <Truncated className="tool-tab-label">{title}</Truncated>
            {ended && <span className="session-ended" aria-label="Session ended" />}
          </button>
          <button type="button" className="pill-close" aria-label={`Close ${title}`} onClick={() => onClose(tool)}>
            <X size={13} />
          </button>
        </div>;
      })}
    </div>
    <ContextMenu position={menu && menuTool ? { x: menu.x, y: menu.y } : null}
      ariaLabel={menuTool ? `Actions for ${menuTool.title || 'tool'}` : 'Tool actions'}
      items={menuTool ? [{ id: 'close', label: 'Close tab', icon: X, action: () => onClose(menuTool) }] : []}
      onClose={() => setMenu(null)} />
  </>;
}
