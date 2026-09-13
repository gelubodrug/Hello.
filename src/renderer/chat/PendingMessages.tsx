import { useEffect, useRef, useState } from 'react';
import { Clock, CornerDownLeft, X, Zap } from 'lucide-react';
import type { QueuedMessage, QueuedMode } from '../../shared/types';
import { api } from '../api';
import { IconButton, MenuButton, type MenuItem } from '../ui/primitives';

const modes: Array<{ value: QueuedMode; label: string; detail: string; Icon: typeof Zap }> = [
  { value: 'steer', label: 'Steer now', detail: 'Reaches the model between its next two steps', Icon: Zap },
  { value: 'next', label: 'Next turn', detail: 'Said on its own when this reply finishes', Icon: CornerDownLeft },
  { value: 'later', label: 'Hold', detail: 'Kept here until you send it yourself', Icon: Clock },
];
const modeOf = (mode: QueuedMode) => modes.find(item => item.value === mode)!;

/**
 * What you said while the model was still working, before it has been said.
 * It sits over the composer rather than in the transcript because it is not
 * part of the conversation yet: it can still be reworded, re-aimed or dropped.
 */
export function PendingMessages({ items, onChange, onError }: {
  items: QueuedMessage[];
  onChange: (items: QueuedMessage[]) => void;
  onError: (reason: unknown) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  if (!items.length) return null;
  const run = (task: Promise<QueuedMessage[]>) => void task.then(onChange).catch(onError);
  const commit = (item: QueuedMessage) => {
    setEditing(null);
    const text = draft.trim();
    if (!text || text === item.text) return;
    run(api.chat.reviseQueued(item.id, { text }));
  };
  return (
    <ul className="pending-messages" aria-label="Messages waiting to be sent">
      {items.map(item => {
        const mode = modeOf(item.mode);
        const choices: MenuItem[] = modes.map(option => ({
          id: option.value,
          label: option.label,
          detail: option.detail,
          icon: option.Icon,
          checked: option.value === item.mode,
          action: () => run(api.chat.reviseQueued(item.id, { mode: option.value })),
        }));
        return (
          <li key={item.id} className="pending-message" data-mode={item.mode}>
            <MenuButton
              label={`Delivery: ${mode.label}`}
              menuLabel="Deliver this message"
              align="start"
              className="pending-mode"
              items={choices}
            >
              <mode.Icon size={13} aria-hidden />
              <span>{mode.label}</span>
            </MenuButton>
            {editing === item.id ? (
              <textarea
                ref={input}
                className="pending-edit"
                aria-label="Edit this message"
                value={draft}
                rows={1}
                onChange={event => setDraft(event.target.value)}
                onBlur={() => commit(item)}
                onKeyDown={event => {
                  if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    commit(item);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="pending-text"
                title="Edit this message"
                onClick={() => { setDraft(item.text); setEditing(item.id); }}
              >
                {item.text}
              </button>
            )}
            <IconButton label="Don’t send this message" onClick={() => run(api.chat.dropQueued(item.id, item.conversationId))}>
              <X size={13} />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}
