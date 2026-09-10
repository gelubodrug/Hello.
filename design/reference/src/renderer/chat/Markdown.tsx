import type { ComponentType, JSX } from 'react';
import type { Element as HastElement, Nodes as HastNode } from 'hast';
import type { Nodes as MdastNode, Root as MdastRoot } from 'mdast';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { TruncatedText } from '../ui/TruncatedText';

import styles from './Markdown.module.css';

export interface MarkdownProps {
  content: string;
  /** Optional plug-in for fenced code blocks. When omitted, a plain <pre><code> is rendered. */
  CodeBlockComponent?: ComponentType<{ code: string; language?: string }>;
  /** Adds compact host chips to paragraphs in sourced assistant responses. */
  showSourceChips?: boolean;
}

export interface MarkdownSource {
  url: string;
  title: string;
  host: string;
}

/** Mirrors `PropertyDefinition` from hast-util-sanitize. */
type PropertyDefinition =
  string | [string, ...Array<string | number | boolean | RegExp | null | undefined>];

/**
 * Exact Markdown-only sanitize allowlist (raw HTML is never parsed):
 *
 * - Tags are limited to CommonMark output plus GFM delete/table/task-list
 *   elements and the section/sup elements generated for footnotes.
 * - Anchors keep href/title/id and only GFM's footnote class, aria, and data
 *   metadata. `target`/`rel` are never accepted from content; the component
 *   override below owns them.
 * - Code keeps only `language-*` classes; list classes are limited to GFM's
 *   task-list markers; images keep src/alt/title plus an accessible label.
 * - `input` is intentionally narrow: only the disabled checkbox emitted by
 *   GFM task lists survives. No form, button, iframe, script, style, or other
 *   interactive/embedding tag is present in the tag allowlist.
 * - URL protocol filtering remains inherited from `defaultSchema`.
 *
 * mdast-util-to-hast already prefixes generated footnote ids with
 * `user-content-`; an empty sanitizer clobberPrefix avoids prefixing those
 * safe generated ids a second time, which would break in-page backlinks.
 */
const MARKDOWN_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'strong',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
];

const MARKDOWN_ATTRIBUTES: Record<string, PropertyDefinition[]> = {
  a: [
    'href',
    'title',
    'id',
    'ariaDescribedBy',
    'ariaLabel',
    'dataFootnoteBackref',
    'dataFootnoteRef',
    ['className', 'data-footnote-backref'],
  ],
  code: [['className', /^language-[\w-]+$/]],
  h2: ['id', ['className', 'sr-only']],
  img: ['src', 'alt', 'title', 'ariaLabel'],
  input: [['disabled', true], ['type', 'checkbox'], 'checked'],
  li: ['id', ['className', 'task-list-item']],
  ol: ['start', ['className', 'contains-task-list']],
  section: ['dataFootnotes', ['className', 'footnotes']],
  ul: [['className', 'contains-task-list']],
};

const schema: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: MARKDOWN_TAGS,
  attributes: MARKDOWN_ATTRIBUTES,
  clobberPrefix: '',
  protocols: {
    ...defaultSchema.protocols,
    // `attachment://` serves conversation attachment files (T111 browser
    // screenshots) from `${userData}` via the main process's scoped protocol
    // handler; http(s) stay inherited from the default schema.
    src: ['http', 'https', 'attachment'],
  },
};

/** Parse `language-xxx` out of a code element's className. */
function parseLanguage(className: string | undefined): string | undefined {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return match?.[1];
}

function webSource(url: string, label: string): MarkdownSource | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const host = parsed.hostname.replace(/^www\./, '');
    const normalizedLabel = label.replace(/\s+/g, ' ').trim();
    return {
      url: parsed.toString(),
      title: normalizedLabel || host,
      host,
    };
  } catch {
    return null;
  }
}

function uniqueSources(sources: MarkdownSource[]): MarkdownSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function mdastText(node: MdastNode): string {
  if ((node.type === 'text' || node.type === 'inlineCode') && 'value' in node) {
    return node.value;
  }
  if (node.type === 'image') return node.alt ?? '';
  if (!('children' in node)) return '';
  return node.children.map((child) => mdastText(child)).join('');
}

/** Extracts the safe web links ReactMarkdown will render, preserving document order. */
export function extractMarkdownSources(content: string): MarkdownSource[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content) as MdastRoot;
  const definitions = new Map<string, string>();
  const sources: MarkdownSource[] = [];

  function collectDefinitions(node: MdastNode): void {
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
    if ('children' in node) node.children.forEach(collectDefinitions);
  }

  function collectLinks(node: MdastNode): void {
    if (node.type === 'link') {
      const source = webSource(node.url, mdastText(node));
      if (source) sources.push(source);
    } else if (node.type === 'linkReference') {
      const url = definitions.get(node.identifier);
      const source = url ? webSource(url, mdastText(node)) : null;
      if (source) sources.push(source);
    }

    if ('children' in node) node.children.forEach(collectLinks);
  }

  collectDefinitions(tree);
  collectLinks(tree);
  return uniqueSources(sources);
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element' && node.tagName === 'img') {
    return typeof node.properties.alt === 'string' ? node.properties.alt : '';
  }
  if (!('children' in node)) return '';
  return node.children.map((child) => hastText(child)).join('');
}

function paragraphSources(node: HastElement | undefined): MarkdownSource[] {
  if (!node) return [];
  const sources: MarkdownSource[] = [];

  function collectLinks(child: HastNode): void {
    if (child.type === 'element' && child.tagName === 'a') {
      const href = child.properties.href;
      const source = typeof href === 'string' ? webSource(href, hastText(child)) : null;
      if (source) sources.push(source);
    }
    if ('children' in child) child.children.forEach(collectLinks);
  }

  collectLinks(node);
  return uniqueSources(sources);
}

export function Markdown({
  content,
  CodeBlockComponent,
  showSourceChips = false,
}: MarkdownProps): JSX.Element {
  const components: Components = {
    a({ node: _node, href, children, ...rest }) {
      const isInPageLink = href?.startsWith('#') ?? false;

      return (
        <a
          {...rest}
          href={href}
          target={isInPageLink ? undefined : '_blank'}
          rel={isInPageLink ? undefined : 'noopener noreferrer'}
        >
          {children}
        </a>
      );
    },

    // Inline images (T111 screenshots): tokened rounding, a subtle border
    // frame, and a max width bounded to the conversation column — see
    // `.image` in Markdown.module.css.
    img({ node: _node, alt, ...rest }) {
      return <img {...rest} alt={alt ?? ''} className={styles.image} loading="lazy" />;
    },

    p({ node, children, ...rest }) {
      const sources = showSourceChips ? paragraphSources(node) : [];
      const additionalSourceCount = Math.max(0, sources.length - 1);

      return (
        <p {...rest}>
          {children}
          {sources.length > 0 ? (
            <>
              {' '}
              <span
                className={styles.inlineSources}
                aria-label={`Sources: ${sources.map((source) => source.host).join(', ')}`}
                title={sources.map((source) => source.url).join('\n')}
              >
                <TruncatedText className={styles.inlineSourceHost}>
                  {sources[0].host}
                </TruncatedText>
                {additionalSourceCount > 0 ? (
                  <span className={styles.inlineSourceCount}>+{additionalSourceCount}</span>
                ) : null}
              </span>
            </>
          ) : null}
        </p>
      );
    },

    table({ node: _node, children, ...rest }) {
      return (
        <div
          className={styles.tableScroll}
          role="region"
          aria-label="Scrollable table"
          tabIndex={0}
        >
          <table {...rest}>{children}</table>
        </div>
      );
    },

    // react-markdown wraps fenced code in <pre>; the `code` override below
    // renders the whole block (or CodeBlockComponent), so `pre` just passes
    // its child through to avoid an extra wrapper.
    pre({ children }) {
      return <>{children}</>;
    },

    code({ node: _node, className, children, ...rest }) {
      const language = parseLanguage(className);
      const raw = String(children ?? '');
      // v9 drops the `inline` flag: a fenced block is one with a language
      // class or multi-line content; everything else is inline.
      const isBlock = language !== undefined || raw.includes('\n');

      if (!isBlock) {
        return (
          <code {...rest} className={styles.inlineCode}>
            {children}
          </code>
        );
      }

      const code = raw.replace(/\n$/, '');

      if (CodeBlockComponent) {
        return <CodeBlockComponent code={code} language={language} />;
      }

      return (
        <pre className={styles.pre}>
          <code className={className}>{code}</code>
        </pre>
      );
    },
  };

  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
