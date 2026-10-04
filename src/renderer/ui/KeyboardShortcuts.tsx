import { useEffect, useState } from 'react';
import { Dialog } from './primitives';

interface Shortcut { keys: string; label: string; }
interface Group { title: string; items: Shortcut[]; }

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

const GROUPS: Group[] = [
  { title: 'Composer', items: [
    { keys: `${mod} + Enter`, label: 'Send message' },
    { keys: 'Enter', label: 'Send message' },
    { keys: 'Shift + Enter', label: 'New line' },
    { keys: '↑ / ↓', label: 'Step through your earlier messages' },
  ]},
  { title: 'Navigation', items: [
    { keys: `${mod} + /`, label: 'Show keyboard shortcuts' },
    { keys: `${mod} + K`, label: 'Open command palette' },
    { keys: `${mod} + N`, label: 'New chat' },
    { keys: `${mod} + F`, label: 'Find in chat' },
    { keys: 'Esc', label: 'Close dialog or menu' },
  ]},
];

/** A single ⌘ + / overlay listing the shortcuts a reader can learn by looking. */
export function KeyboardShortcuts(): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Open on ⌘ + / (or Ctrl + / off Mac), close on the same chord or Esc.
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        setOpen(current => !current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  return (
    <Dialog open={open} title="Keyboard shortcuts" onClose={() => setOpen(false)} dismissOnBackdrop wide>
      <div className="shortcuts-grid">
        {GROUPS.map(group => (
          <section key={group.title} className="shortcuts-group" aria-label={group.title}>
            <h2>{group.title}</h2>
            <dl>
              {group.items.map(item => (
                <div key={`${group.title}-${item.keys}-${item.label}`} className="shortcuts-row">
                  <dt><kbd>{item.keys}</kbd></dt>
                  <dd>{item.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted shortcuts-hint">Press <kbd>{mod} + /</kbd> again or <kbd>Esc</kbd> to close.</p>
    </Dialog>
  );
}
