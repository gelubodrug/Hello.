import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { onNativeBrowserFocus } from '../api';
import { animateSurface } from './surface-motion';

/** Temporary edge navigation does not change the saved sidebar preference or
 * resize workspaces. */
export function SidebarChrome({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [peek, setPeek] = useState(false);
  const [present, setPresent] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const clearLeave = () => { clearTimeout(leaveTimer.current); leaveTimer.current = undefined; };
  const reveal = () => { clearLeave(); if (!visible) setPeek(true); };

  useLayoutEffect(() => {
    if (visible) { setPeek(false); setPresent(false); return; }
    if (peek && !present) { setPresent(true); return; }
    if (!present || !drawer.current) return;
    return animateSurface(drawer.current, peek ? 'enter' : 'exit', {
      direction: 'left', onFinish: () => { if (!peek) setPresent(false); },
    });
  }, [visible, peek, present]);

    useEffect(() => {
    if (visible || !present) return;
    const inside = (target: EventTarget | null) => target instanceof Node &&
      (!!drawer.current?.contains(target) || !!edge.current?.contains(target));
    const inPopup = (target: EventTarget | null) => target instanceof Element &&
      !!target.closest('.menu-popup,[role="dialog"]');
    const inDrawerBounds = (event: PointerEvent) => {
      const node = drawer.current;
      if (!node) return false;
      // Electron's draggable titlebar is native hit-test space: crossing into
      // it can leave the document without leaving the visible navigation.
      // Include the absolute header explicitly, not just DOM event ancestry.
      return [node, node.querySelector<HTMLElement>('.titlebar')].some(surface => {
        if (!surface) return false;
        const bounds = surface.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 &&
          event.clientX >= bounds.left && event.clientX < bounds.right &&
          event.clientY >= bounds.top && event.clientY < bounds.bottom;
      });
    };
    const dismiss = () => { clearLeave(); setPeek(false); };
    const move = (event: PointerEvent) => {
      if (inside(event.target) || inDrawerBounds(event) || inPopup(event.target) ||
          drawer.current?.querySelector('[aria-haspopup="menu"][aria-expanded="true"]') ||
          (inside(document.activeElement) && document.activeElement?.matches('input'))) { clearLeave(); return; }
      if (!leaveTimer.current) leaveTimer.current = setTimeout(dismiss, 220);
    };
    const down = (event: PointerEvent) => { if (!inside(event.target) && !inDrawerBounds(event) && !inPopup(event.target)) dismiss(); };
    const leaveDocument = (event: PointerEvent) => {
      if (inDrawerBounds(event) || inside(event.relatedTarget) || inPopup(event.relatedTarget)) {
        clearLeave(); return;
      }
      dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !inPopup(event.target)) {
        event.preventDefault(); dismiss(); edge.current?.focus({ preventScroll: true });
      }
    };
    // Focus leaving the window closes the drawer, unless the drawer is what
    // holds it: opening search focuses its field, and a native menu or a guest
    // page taking focus must not pull the navigation out from under the pointer.
    const leftWindow = () => { if (!inside(document.activeElement)) dismiss(); };
    const stopNativeFocus = onNativeBrowserFocus(dismiss);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    document.documentElement.addEventListener('pointerleave', leaveDocument);
    window.addEventListener('blur', leftWindow);
    return () => {
      clearLeave(); stopNativeFocus();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
      document.documentElement.removeEventListener('pointerleave', leaveDocument);
      window.removeEventListener('blur', leftWindow);
    };
  }, [visible, present]);

  // Enter/Space on the edge trigger makes the hidden navigation keyboard-usable.
  const focusDrawer = () => {
    reveal();
    requestAnimationFrame(() => drawer.current?.querySelector<HTMLButtonElement>('button')?.focus());
  };
  return <>
    {/* The window is dragged by the strip beside its controls, pinned or not:
        the title bar itself holds buttons and must stay clickable. */}
    <div className="window-drag-strip" aria-hidden="true" />
    {!visible &&
      <button ref={edge} type="button" className="sidebar-edge" aria-label="Show sidebar temporarily"
        aria-expanded={peek} aria-controls="hello-navigation" onPointerEnter={reveal} onClick={focusDrawer} />}
    <div ref={drawer} id="hello-navigation" className="navigation-area" data-pinned={visible}
      hidden={!visible && !present} aria-hidden={!visible && !peek || undefined}
      onPointerEnter={reveal}>
      {children}
    </div>
  </>;
}
