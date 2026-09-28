import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import './PillSwitch.css';

export interface PillSwitchOption<T extends string> {
  value: T;
  /** What the option is called, for the pointer and for a screen reader. */
  label: string;
  /** The longer line on hover, when the label alone does not say enough. */
  title?: string;
  Icon: LucideIcon;
}
export interface PillSwitchProps<T extends string> {
  /** What the pair of options decides, e.g. "Chat mode" or "Plan". */
  label: string;
  value: T;
  options: readonly [PillSwitchOption<T>, PillSwitchOption<T>];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A choice between two states that STAYS: collapsed it shows the side you are
 * on, clicking opens it to both, picking one closes it again. Chat/Coder was
 * the first of these; Plan on/off is the same control and reads as the same
 * kind of decision (user, 17.09: "fă switch on off ca pilula de coder").
 *
 * Controlled presentation only: choosing delegates to the host, and this
 * component never owns a runtime, a setting or a stored value.
 */
export function PillSwitch<T extends string>({
  label, value, options, onChange, disabled = false, className = '',
}: PillSwitchProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const pendingFocus = useRef<T | null>(null);
  const hintId = useId();
  const open = expanded && !disabled;
  const other = options.find(option => option.value !== value)?.value ?? value;

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

  const select = (next: T) => {
    if (disabled) return;
    if (!open) {
      setExpanded(true);
      return;
    }
    onChange(next);
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
    const next = event.key === 'Home' ? options[0].value : event.key === 'End' ? options[1].value : other;
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
      className={`pill-switch${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label={label}
      aria-describedby={hintId}
      aria-disabled={disabled || undefined}
      data-expanded={open}
      data-second={value === options[1].value}
      onKeyDown={onKeyDown}
      onBlurCapture={event => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setExpanded(false);
      }}
    >
      <span id={hintId} className="sr-only">
        {`Click, Enter or Space reveals ${options[0].label} and ${options[1].label}. Arrow keys select. Enter or Space confirms and closes; Escape closes.`}
      </span>
      <div className="pill-switch__options">
        {options.map(option => (
          <button
            key={option.value}
            ref={node => { buttons.current[option.value] = node; }}
            type="button"
            role="radio"
            aria-label={option.label}
            aria-checked={value === option.value}
            aria-hidden={!open && value !== option.value || undefined}
            title={option.title ?? option.label}
            data-value={option.value}
            className="pill-switch__option"
            tabIndex={!disabled && value === option.value ? 0 : -1}
            disabled={disabled}
            onClick={() => select(option.value)}
          >
            <option.Icon size={16} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
