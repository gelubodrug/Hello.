import {
  Children,
  isValidElement,
  useEffect,
  useContext,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Image as ImageIcon } from "lucide-react";
import { api } from "../api";
import { ErrorNote, IconButton, errorText } from "../ui/primitives";
import type { WebSource } from '../../shared/web';
import { citationPlugin } from './citations';
import { FileNavigation } from '../files/navigation';
import { fileLink, type FileLink } from '../../shared/files';

type Token = { content: string; color?: string; fontStyle?: number };
let highlighter: Promise<typeof import("shiki")> | undefined;

export function CodeBlock({
  code,
  language = "text",
  lineNumbers = false,
}: {
  code: string;
  language?: string;
  lineNumbers?: boolean;
}) {
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyCode = async () => {
    setCopying(true);
    setCopied(false);
    setCopyError(null);
    try {
      await api.system.copy({ text: code });
      setCopied(true);
    } catch (reason) {
      setCopyError(errorText(reason));
    } finally {
      setCopying(false);
    }
  };
  useEffect(() => {
    let current = true;
    setTokens(null);
    if (code.length <= 50_000 && language !== "text") {
      highlighter ??= import("shiki");
      void highlighter
        .then(({ codeToTokens }) =>
          codeToTokens(code, { lang: language as never, theme: "github-dark" }),
        )
        .then((result) => {
          if (current) setTokens(result.tokens);
        })
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [code, language]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const plainLines = lineNumbers && !tokens ? code.split('\n') : [];
  return (
    <div className="code-block" data-line-numbers={lineNumbers || undefined}>
      <div className="code-heading">
        <span>{language}</span>
        <IconButton
          label={copied ? "Code copied" : "Copy code"}
          disabled={copying}
          onClick={() => void copyCode()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </IconButton>
      </div>
      <pre>
        <code>
          {tokens
            ? tokens.map((line, i) => (
                <span key={i} className="code-line" data-line={i + 1}>
                  {line.map((token, j) => (
                    <span
                      key={j}
                      style={{
                        color: token.color,
                        fontStyle:
                          token.fontStyle && token.fontStyle & 1
                            ? "italic"
                            : undefined,
                        fontWeight:
                          token.fontStyle && token.fontStyle & 2
                            ? 600
                            : undefined,
                      }}
                    >
                      {token.content}
                    </span>
                  ))}
                  {!lineNumbers && i < tokens.length - 1 ? "\n" : ""}
                </span>
              ))
            : lineNumbers ? plainLines.map((line, i) => <span className="code-line" data-line={i + 1} key={i}>{line || ' '}</span>) : code}
        </code>
      </pre>
      <ErrorNote error={copyError} />
    </div>
  );
}

function plainText(value: ReactNode): string {
  return Children.toArray(value)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plainText(child.props.children)
          : "",
    )
    .join("");
}

function headingAnchors() {
  return (root: any) => {
    const counts = new Map<string, number>();
    const visit = (node: any) => {
      if (node.type === 'heading') {
        const value = (item: any): string => item.value ?? (item.children ?? []).map(value).join('');
        const base = value(node).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
        const count = counts.get(base) ?? 0; counts.set(base, count + 1);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `file-heading-${base}${count ? `-${count}` : ''}` } };
      }
      node.children?.forEach(visit);
    };
    visit(root);
  };
}

function fileReferences() {
  return (root: any) => {
    const visit = (node: any) => {
      if (node.type === 'link' || node.type === 'linkReference') return;
      node.children?.forEach((child: any, index: number) => {
        if (child.type === 'inlineCode' && !child.value.includes('\n') && /\.(?:md|tsx?|jsx?|py|rs|go|swift|json|ya?ml|toml|css|html|txt)(?::\d+(?::\d+)?)?$/i.test(child.value) && fileLink(child.value)) {
          node.children[index] = { type: 'link', url: child.value, title: `Open ${child.value} in Files`, children: [child] };
        } else visit(child);
      });
    };
    visit(root);
  };
}

export function Markdown({ text, sources = [], onOpenFile, filePath }: { text: string; sources?: readonly WebSource[]; onOpenFile?: (target: FileLink) => void; filePath?: string }) {
  const navigateFile = useContext(FileNavigation);
  const openFile = onOpenFile ?? navigateFile;
  const openLink = (href: string) => {
    const target = fileLink(href, filePath);
    if (openFile && target) openFile(target);
    else void api.system.openExternal(href).catch(() => undefined);
  };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, citationPlugin(sources), ...(filePath ? [headingAnchors] : openFile ? [fileReferences] : [])]}
        urlTransform={url => openFile && fileLink(url, filePath) ? url : defaultUrlTransform(url)}
        components={{
          pre: ({ children }) => {
            const node = Children.toArray(children)[0];
            const language = isValidElement<{ className?: string }>(node)
              ? /language-([^ ]+)/.exec(node.props.className ?? "")?.[1]
              : undefined;
            return (
              <CodeBlock
                code={plainText(children).replace(/\n$/, "")}
                language={language}
              />
            );
          },
          a: ({ href, title, children }) => (
            <a
              href={href}
              title={title}
              className={title?.startsWith('Source [') && sources.some(source => source.url === href) ? 'source-citation' : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (href) openLink(href);
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <button
              type="button"
              className="markdown-image-link"
              onClick={() => {
                if (src) openLink(src);
              }}
            >
              <ImageIcon size={16} />
              {alt || "Open image"}
            </button>
          ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
