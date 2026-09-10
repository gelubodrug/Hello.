import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CodeXml, MessageCircle } from 'lucide-react';
import './ChatModeSwitch.css';

export type ChatMode = 'chat' | 'coder';
export interface ChatModeSwitchProps {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled?: boolean;
  className?: string;
}

const modes = [
  { value: 'chat', label: 'Chat', Icon: MessageCircle },
  { value: 'coder', label: 'Coder', Icon: CodeXml },
] as const;

/** A controlled presentation control. Selecting a mode delegates to the host;
 * this component never starts, switches, or owns an agent runtime. */
export function ChatModeSwitch({ value, onChange, disabled = false, className = '' }: ChatModeSwitchProps) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<ChatMode, HTMLButtonElement | null>>>({});
  const pendingFocus = useRef<ChatMode | null>(null);
  const hintId = useId();
  const open = expanded && !disabled;

  const close = () => {
    pendingFocus.current = value;
    setExpanded(false);
  };

  useLayoutEffect(() => {
    if (disabled) return;
    const requested = pendingFocus.current;
    pendingFocus.current = null;
    if (requested) buttons.current[open ? requested : value]?.focus({ preventScroll: true });
    else if (!open && root.current?.contains(document.activeElement)) buttons.current[value]?.focus({ preventScroll: true });
  }, [open, value, disabled]);

  useEffect(() => {
    if (disabled) setExpanded(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, [open]);

  const select = (mode: ChatMode) => {
    if (disabled) return;
    if (!open) {
      setExpanded(true);
      return;
    }
    onChange(mode);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const focused = event.target instanceof HTMLElement ? event.target.dataset.mode : undefined;
    const current = focused === 'chat' || focused === 'coder' ? focused : value;
    const next: ChatMode = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'coder' : current === 'chat' ? 'coder' : 'chat';
    pendingFocus.current = next;
    setExpanded(true);
    onChange(next);
    // Already-open controlled values may intentionally remain unchanged in
    // the parent; keep arrow-key focus working in that case too.
    if (open) buttons.current[next]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={root}
      className={`chat-mode-switch${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label="Chat mode"
      aria-describedby={hintId}
      aria-disabled={disabled || undefined}
      data-expanded={open}
      data-value={value}
      onKeyDown={onKeyDown}
      onBlurCapture={event => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setExpanded(false);
      }}
    >
      <span id={hintId} className="sr-only">Click, Enter or Space reveals Chat and Coder. Arrow keys select. Enter or Space confirms and closes; Escape closes.</span>
      <div className="chat-mode-switch__options">
        {modes.map(({ value: mode, label, Icon }) => (
          <button
            key={mode}
            ref={node => { buttons.current[mode] = node; }}
            type="button"
            role="radio"
            aria-label={label}
            aria-checked={value === mode}
            aria-hidden={!open && value !== mode || undefined}
            title={`${label} mode`}
            data-mode={mode}
            className="chat-mode-switch__option"
            tabIndex={!disabled && value === mode ? 0 : -1}
            disabled={disabled}
            onClick={() => select(mode)}
          >
            <Icon size={16} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
