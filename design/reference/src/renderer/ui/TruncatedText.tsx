import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { useConditionalTruncation } from './useConditionalTruncation';

export interface TruncatedTextProps extends ComponentPropsWithoutRef<'span'> {
  children: ReactNode;
}

/** A span whose shared fade treatment activates only for measured overflow. */
export function TruncatedText({ children, className, ...props }: TruncatedTextProps) {
  const ref = useConditionalTruncation<HTMLSpanElement>(children);
  const classes = className ? `${className} truncate-fade` : 'truncate-fade';

  return (
    <span {...props} ref={ref} className={classes}>
      {children}
    </span>
  );
}
