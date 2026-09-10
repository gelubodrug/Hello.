import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

import './Input.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Marks the input as invalid, e.g. after failed validation. */
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, ...rest },
  ref,
) {
  const classes = ['input', className].filter(Boolean).join(' ');

  return <input ref={ref} className={classes} aria-invalid={invalid || undefined} {...rest} />;
});
