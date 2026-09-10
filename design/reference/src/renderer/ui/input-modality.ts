/**
 * Which device is currently driving the app: the pointer, or the keyboard.
 *
 * `:focus-visible` is meant to be the keyboard's indicator, but Chromium also
 * paints it for *programmatic* focus — and this app restores focus by script
 * every time an overlay closes (`ui/Dialog.tsx` returns focus to whatever was
 * focused when it opened; the sidebar menus return it to their trigger). So a
 * mouse-only round trip — click the sidebar's "Runbook" row, the dialog opens,
 * close it with the mouse — ends with a keyboard focus ring drawn around a row
 * nobody reached with a keyboard.
 *
 * No selector can tell a script-restored focus from a Tab, so the modality is
 * recorded here instead and `globals.css` stands the ring down while the
 * pointer is the one driving. A key press flips it straight back, Escape
 * included: closing a dialog from the keyboard is keyboard navigation, and the
 * restored ring is exactly what that user needs to see.
 *
 * Modified keydowns (⌘/⌃/⌥ shortcuts, and the lone modifier press that starts
 * them) are ignored, so holding ⌘ after a click does not turn a pointer
 * interaction into a keyboard one. Shift is not a modifier here — Shift+Tab is
 * keyboard navigation.
 */
export const INPUT_MODALITY_ATTRIBUTE = 'data-input-modality';

export type InputModality = 'pointer' | 'keyboard';

/**
 * Starts recording the input modality on the document element. Called once at
 * renderer start-up; returns a disposer, which only the tests use.
 */
export function trackInputModality(doc: Document = document): () => void {
  const set = (modality: InputModality) => {
    doc.documentElement.setAttribute(INPUT_MODALITY_ATTRIBUTE, modality);
  };

  const handlePointerDown = () => set('pointer');
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    set('keyboard');
  };

  // Capture, so a handler that stops propagation cannot leave the modality
  // stale — and with it a ring that belongs to the other device.
  doc.addEventListener('pointerdown', handlePointerDown, true);
  doc.addEventListener('keydown', handleKeyDown, true);

  return () => {
    doc.removeEventListener('pointerdown', handlePointerDown, true);
    doc.removeEventListener('keydown', handleKeyDown, true);
  };
}
