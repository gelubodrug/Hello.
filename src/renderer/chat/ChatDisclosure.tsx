import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface ChatDisclosureProps {
  id: string;
  open: boolean;
  children: ReactNode;
  className?: string;
}

/** Keep a disclosure's geometry and mounted content stable through reversals. */
export function ChatDisclosure({ id, open, children, className }: ChatDisclosureProps) {
  const element = useRef<HTMLDivElement>(null);
  const [hasOpened, setHasOpened] = useState(open);

  useLayoutEffect(() => {
    if (open) setHasOpened(true);

    const node = element.current;
    if (!node) return;

    // Return focus before hiding from accessibility. An automatic group roll-up
    // can happen while focus is on one of its nested controls.
    const activeElement = node.ownerDocument.activeElement;
    if (!open && activeElement instanceof HTMLElement && node.contains(activeElement)) {
      const trigger = Array.from(node.ownerDocument.querySelectorAll<HTMLElement>('[aria-controls]'))
        .find(candidate => candidate.getAttribute('aria-controls')?.split(/\s+/).includes(id));
      trigger?.focus({ preventScroll: true });
      if (node.contains(node.ownerDocument.activeElement)) activeElement.blur();
    }

    // Layout effects run before paint; the closing content can still animate,
    // but cannot receive input or be exposed as an accessible subtree.
    node.inert = !open;
    if (open) node.removeAttribute('aria-hidden');
    else node.setAttribute('aria-hidden', 'true');
  }, [id, open]);

  return <div
    id={id}
    ref={element}
    className={['chat-disclosure', className].filter(Boolean).join(' ')}
    data-open={open}
  >
    <div className="chat-disclosure-clip">
      <div className="chat-disclosure-content">
        {open || hasOpened ? children : null}
      </div>
    </div>
  </div>;
}
