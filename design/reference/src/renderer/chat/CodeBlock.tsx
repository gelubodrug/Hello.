import { useEffect, useRef, useState } from 'react';
import { Check, Copy, WrapText } from 'lucide-react';
import { codeToHtml } from 'shiki';

import { TruncatedText } from '../ui/TruncatedText';

import styles from './CodeBlock.module.css';

export interface CodeBlockProps {
  code: string;
  /** Fence info string, e.g. "ts", "python". Unknown values fall back to plaintext. */
  language?: string;
  /** Terminal transcript blocks reuse the controls without nesting another outlined card. */
  appearance?: 'card' | 'terminal-command' | 'terminal-output';
}

const COPIED_RESET_MS = 1500;
export const HIGHLIGHT_DEBOUNCE_MS = 160;

const SHIKI_THEMES = {
  light: 'github-light',
  dark: 'github-dark',
} as const;

interface LanguageSpec {
  label: string | null;
  shikiLanguage: string;
  shouldHighlight: boolean;
}

/**
 * Supported shiki language ids. Anything outside this allowlist is highlighted
 * as `plaintext` so we never ask shiki to lazily load an unbundled grammar and
 * never surprise the reader with a failed highlight. Keys are the fence tokens
 * a model is likely to emit; values are the shiki grammar id to load.
 */
const LANGUAGE_ALIASES: Record<string, Omit<LanguageSpec, 'shouldHighlight'>> = {
  ts: { shikiLanguage: 'ts', label: 'TypeScript' },
  tsx: { shikiLanguage: 'tsx', label: 'TSX' },
  js: { shikiLanguage: 'js', label: 'JavaScript' },
  jsx: { shikiLanguage: 'jsx', label: 'JSX' },
  json: { shikiLanguage: 'json', label: 'JSON' },
  py: { shikiLanguage: 'python', label: 'Python' },
  python: { shikiLanguage: 'python', label: 'Python' },
  sh: { shikiLanguage: 'bash', label: 'Shell' },
  shell: { shikiLanguage: 'bash', label: 'Shell' },
  bash: { shikiLanguage: 'bash', label: 'Bash' },
  zsh: { shikiLanguage: 'bash', label: 'Zsh' },
  html: { shikiLanguage: 'html', label: 'HTML' },
  css: { shikiLanguage: 'css', label: 'CSS' },
  sql: { shikiLanguage: 'sql', label: 'SQL' },
  yaml: { shikiLanguage: 'yaml', label: 'YAML' },
  yml: { shikiLanguage: 'yaml', label: 'YAML' },
  diff: { shikiLanguage: 'diff', label: 'Diff' },
  patch: { shikiLanguage: 'diff', label: 'Diff' },
  text: { shikiLanguage: 'plaintext', label: 'Text' },
  txt: { shikiLanguage: 'plaintext', label: 'Text' },
  plain: { shikiLanguage: 'plaintext', label: 'Text' },
  plaintext: { shikiLanguage: 'plaintext', label: 'Text' },
};

/** Resolves fence info to a supported shiki grammar plus the label we should show. */
export function resolveLanguage(language: string | undefined): LanguageSpec {
  if (!language) {
    return { shikiLanguage: 'plaintext', label: null, shouldHighlight: false };
  }

  const trimmedLanguage = language.trim();
  if (!trimmedLanguage) {
    return { shikiLanguage: 'plaintext', label: null, shouldHighlight: false };
  }

  const knownLanguage = LANGUAGE_ALIASES[trimmedLanguage.toLowerCase()];
  if (!knownLanguage) {
    return { shikiLanguage: 'plaintext', label: trimmedLanguage, shouldHighlight: false };
  }

  return {
    ...knownLanguage,
    shouldHighlight: knownLanguage.shikiLanguage !== 'plaintext',
  };
}

/** Initial renders/language changes highlight immediately; streaming code updates debounce. */
export function resolveHighlightDelay(
  previousCode: string | null,
  previousLanguage: string | null,
  nextCode: string,
  nextLanguage: Pick<LanguageSpec, 'shikiLanguage' | 'shouldHighlight'>,
): number {
  if (!nextLanguage.shouldHighlight) {
    return 0;
  }

  if (previousCode === null || previousLanguage === null) {
    return 0;
  }

  if (previousLanguage !== nextLanguage.shikiLanguage) {
    return 0;
  }

  if (previousCode === nextCode) {
    return 0;
  }

  return HIGHLIGHT_DEBOUNCE_MS;
}

/**
 * CodeBlock (task T058 / FR-012, hover toolbar T097): a shiki-highlighted
 * code block with a hover-revealed toolbar (language label, soft-wrap
 * toggle, copy action).
 *
 * Highlighting is async, so the block first paints an unstyled `<pre>` fallback
 * and swaps in shiki's escaped HTML once it resolves — the content is therefore
 * never blank. FR-012: the block clips its own overflow and hands horizontal
 * scroll to the inner `<pre>`, so a long line can never widen the conversation.
 */
export function CodeBlock({ code, language, appearance = 'card' }: CodeBlockProps): JSX.Element {
  const languageSpec = resolveLanguage(language);
  const { label, shikiLanguage, shouldHighlight } = languageSpec;

  const [html, setHtml] = useState<string | null>(null);
  const [highlightedCode, setHighlightedCode] = useState(code);
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousHighlightInput = useRef<{ code: string; language: string } | null>(null);

  useEffect(() => {
    if (highlightTimer.current !== null) {
      clearTimeout(highlightTimer.current);
      highlightTimer.current = null;
    }

    if (!shouldHighlight) {
      previousHighlightInput.current = null;
      setHighlightedCode(code);
      setHtml(null);
      return;
    }

    const delay = resolveHighlightDelay(
      previousHighlightInput.current?.code ?? null,
      previousHighlightInput.current?.language ?? null,
      code,
      { shikiLanguage, shouldHighlight },
    );

    const commitCode = (): void => {
      previousHighlightInput.current = {
        code,
        language: shikiLanguage,
      };
      setHighlightedCode(code);
    };

    if (delay === 0) {
      commitCode();
      return;
    }

    highlightTimer.current = setTimeout(commitCode, delay);

    return () => {
      if (highlightTimer.current !== null) {
        clearTimeout(highlightTimer.current);
        highlightTimer.current = null;
      }
    };
  }, [code, shikiLanguage, shouldHighlight]);

  useEffect(() => {
    if (!shouldHighlight) {
      return;
    }

    let cancelled = false;

    void codeToHtml(highlightedCode, {
      lang: shikiLanguage,
      themes: SHIKI_THEMES,
      defaultColor: false,
    })
      .then((result) => {
        if (!cancelled) {
          setHtml(result);
        }
      })
      .catch(() => {
        // Highlighting is best-effort; the plain fallback stays on failure.
        if (!cancelled) {
          setHtml(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [highlightedCode, shikiLanguage, shouldHighlight]);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
      if (highlightTimer.current !== null) {
        clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard can be unavailable/denied; fail silently rather than throw.
      return;
    }

    setCopied(true);
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <div
      className={styles.block}
      data-appearance={appearance === 'card' ? undefined : appearance}
    >
      <div className={styles.toolbar}>
        {label ? <TruncatedText className={styles.language}>{label}</TruncatedText> : null}
        <span className={styles.headerSpacer} />
        <button
          type="button"
          className={styles.wrapButton}
          aria-label={wrapped ? 'Disable line wrap' : 'Enable line wrap'}
          aria-pressed={wrapped}
          onClick={() => setWrapped((value) => !value)}
        >
          <WrapText className={styles.wrapIcon} size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.copyButton}
          data-copied={copied ? 'true' : 'false'}
          aria-label="Copy code"
          onClick={() => void handleCopy()}
        >
          <span className={styles.copyIcons}>
            <Copy
              className={`${styles.copyIcon} ${styles.copyIconIdle}`}
              size={14}
              aria-hidden="true"
            />
            <Check
              className={`${styles.copyIcon} ${styles.copyIconCopied}`}
              size={14}
              aria-hidden="true"
            />
          </span>
        </button>
      </div>

      {!shouldHighlight || html === null ? (
        <pre className={wrapped ? `${styles.fallback} ${styles.wrapped}` : styles.fallback}>
          <code>{code}</code>
        </pre>
      ) : (
        // Trusted: shiki emits its own escaped HTML, so this cannot inject markup.
        <div
          className={wrapped ? `${styles.scroll} ${styles.wrapped}` : styles.scroll}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      <span className={styles.srOnly} role="status" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  );
}
