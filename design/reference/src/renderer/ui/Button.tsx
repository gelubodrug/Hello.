import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. Primary > secondary; destructive is reserved for destructive actions. */
  variant?: ButtonVariant;
  /** Lucide icon component rendered before the label, per DESIGNUIguide.md §Icons (16px). */
  icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon: Icon, className, children, ...rest },
  ref,
) {
  const classes = ['btn', `btn-${variant}`, className].filter(Boolean).join(' ');

  return (
    <button ref={ref} className={classes} {...rest}>
      {Icon ? <Icon className="btn-icon" size={16} aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
