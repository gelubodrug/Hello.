import { useEffect, useState } from 'react';
import { Dialog } from './primitives';

interface Shortcut { keys: string; label: string; }
interface Group { title: string; items: Shortcut[]; }

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

// Only keys the app answers to (second review, 05.10: the transcript's keys
// were listed nowhere, and ⌘K read as a palette it never opened).
const GROUPS: Group[] = [
  { title: 'Composer', items: [
    { keys: 'Enter', label: 'Send message' },
    { keys: 'Shift + Enter', label: 'New line' },
    { keys: '↑ / ↓', label: 'Reuse a previous message (empty composer; Esc clears it)' },
    { keys: 'Enter', label: 'Preview the focused image attachment' },
  ]},
  { title: 'Transcript', items: [
    { keys: '↑ / ↓', label: 'Previous or next message' },
    { keys: 'Home / End', label: 'First or last message' },
    { keys: `${mod} + C`, label: 'Copy the focused message' },
  ]},
  { title: 'Terminal', items: [
    { keys: isMac ? '⌘ + F' : 'Ctrl + Shift + F', label: 'Find in the scrollback (terminal focused)' },
    { keys: 'Enter / Shift + Enter', label: 'Older or newer match' },
  ]},
  { title: 'Navigation', items: [
    { keys: `${mod} + /`, label: 'Show keyboard shortcuts' },
    { keys: `${mod} + N`, label: 'New chat' },
    { keys: `${mod} + 1–9`, label: 'Go to the chat at that place in the list' },
    { keys: `${mod} + Shift + ] / [`, label: 'Next or previous chat' },
    { keys: `${mod} + J`, label: 'Next chat waiting for you' },
    { keys: `${mod} + B`, label: 'Show or hide the chats sidebar' },
    { keys: `${mod} + F or K`, label: 'Find in the chat or the notebook on screen' },
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
