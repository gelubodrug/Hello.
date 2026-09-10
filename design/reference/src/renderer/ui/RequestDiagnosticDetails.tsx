import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';

import type { RequestDiagnostic } from '../../shared/errors';
import { Reveal } from './Reveal';

import './RequestDiagnosticDetails.css';

const COPIED_RESET_MS = 1500;

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatStatus(diagnostic: RequestDiagnostic): string | null {
  if (diagnostic.status === undefined) return null;
  return diagnostic.statusText
    ? `${diagnostic.status} ${diagnostic.statusText}`
    : String(diagnostic.status);
}

/**
 * The block the user pastes into an issue or a support chat. Assembled from
 * the same named fields the panel shows, so nothing can appear in the
 * clipboard that is not already on screen.
 */
export function formatRequestDiagnostic(diagnostic: RequestDiagnostic): string {
  const lines = [`${diagnostic.method} ${diagnostic.url}`];

  if (diagnostic.model !== undefined) lines.push(`Model: ${diagnostic.model}`);

  const status = formatStatus(diagnostic);
  if (status !== null) lines.push(`Status: ${status}`);

  if (diagnostic.durationMs !== undefined) {
    lines.push(`Took: ${formatDuration(diagnostic.durationMs)}`);
  }

  if (diagnostic.body !== undefined) {
    lines.push('Response body:', diagnostic.body);
    if (diagnostic.bodyTruncated) lines.push('… (truncated)');
  }

  return lines.join('\n');
}

export interface RequestDiagnosticDetailsProps {
  diagnostic: RequestDiagnostic;
  /** Distinguishes this disclosure's ids when several share a screen. */
  idPrefix: string;
}

/**
 * Collapsed-by-default disclosure of one failed request. Everything above it
 * is a sentence about what went wrong; this is the evidence, and it stays out
 * of the way until asked for (DESIGNUIguide.md §UX rules — progressive
 * disclosure).
 */
export function RequestDiagnosticDetails({
  diagnostic,
  idPrefix,
}: RequestDiagnosticDetailsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatRequestDiagnostic(diagnostic));
    } catch {
      // Clipboard can be unavailable/denied; fail silently rather than throw.
      return;
    }

    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  const panelId = `${idPrefix}-diagnostic`;
  const status = formatStatus(diagnostic);

  return (
    <div className="reqdiag">
      <button
        type="button"
        className="reqdiag-toggle"
        aria-expanded={open}
        // Only while it exists: the panel unmounts when collapsed, and a
        // dangling `aria-controls` target is worse than none.
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((previous) => !previous)}
      >
        <ChevronRight className="reqdiag-chevron" size={14} aria-hidden="true" />
        Details
      </button>

      <Reveal show={open} duration="fast">
        <div className="reqdiag-panel" id={panelId}>
          <dl className="reqdiag-fields">
            <div className="reqdiag-field">
              <dt>Request</dt>
              <dd>{`${diagnostic.method} ${diagnostic.url}`}</dd>
            </div>
            {diagnostic.model !== undefined ? (
              <div className="reqdiag-field">
                <dt>Model</dt>
                <dd>{diagnostic.model}</dd>
              </div>
            ) : null}
            {status !== null ? (
              <div className="reqdiag-field">
                <dt>Status</dt>
                <dd>{status}</dd>
              </div>
            ) : null}
            {diagnostic.durationMs !== undefined ? (
              <div className="reqdiag-field">
                <dt>Took</dt>
                <dd>{formatDuration(diagnostic.durationMs)}</dd>
              </div>
            ) : null}
          </dl>

          {diagnostic.body !== undefined ? (
            <div className="reqdiag-field">
              <span className="reqdiag-term">Response body</span>
              <pre className="reqdiag-body">
                {diagnostic.body}
                {diagnostic.bodyTruncated ? '\n… (truncated)' : ''}
              </pre>
            </div>
          ) : null}

          <button type="button" className="reqdiag-copy" onClick={() => void handleCopy()}>
            {copied ? (
              <Check className="reqdiag-copy-icon" size={14} aria-hidden="true" />
            ) : (
              <Copy className="reqdiag-copy-icon" size={14} aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      </Reveal>
    </div>
  );
}

export default RequestDiagnosticDetails;
