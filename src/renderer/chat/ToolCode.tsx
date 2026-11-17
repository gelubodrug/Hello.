import type { MessagePart } from "../../shared/types";
import { CodeBlock } from "./Markdown";
import { diffLines } from "./diff";

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", html: "html", md: "markdown", py: "python", rs: "rust", go: "go",
  sh: "bash", bash: "bash", zsh: "bash", yaml: "yaml", yml: "yaml", toml: "toml",
};
/** The highlighter's name for a file's language, from its extension; plain otherwise. */
export const languageOf = (path: string) => LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

function args(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
const text = (value: unknown): value is string => typeof value === "string";

/**
 * What a code step asks to do, readably (audit B1): a file_edit as its lines
 * taken out and put in, marked − and + in words as well as colour; a
 * file_write as the file it writes; a bash as the shell line. Anything
 * else, or input that does not parse, is null: the caller shows the JSON as
 * before. All of it is text — nothing the model sent becomes markup. A plain
 * function, not a component, so a null can fall back to the JSON.
 */
export function toolCode(part: Extract<MessagePart, { type: "tool" }>): JSX.Element | null {
  const input = args(part.input);
  if (!input) return null;
  if (part.name === "file_edit" && text(input.path) && text(input.old) && text(input.new)) {
    const lines = diffLines(input.old, input.new);
    return (
      <div className="tool-code">
        <p className="tool-code-path">{input.path}{input.all === true && <span> · every occurrence</span>}</p>
        {lines ? (
          <pre className="tool-diff" aria-label={`Changes to ${input.path}`}>
            {lines.map((line, index) => (
              <span key={index} className="tool-diff-line" data-kind={line.kind}>
                {line.kind === "del" ? "− " : line.kind === "add" ? "+ " : "  "}{line.text}{"\n"}
              </span>
            ))}
          </pre>
        ) : (
          <>
            <p className="tool-code-note">Too long to compare line by line: the text it replaces, then the new text.</p>
            <span className="meta-label">Old</span>
            <CodeBlock code={input.old} language={languageOf(input.path)} />
            <span className="meta-label">New</span>
            <CodeBlock code={input.new} language={languageOf(input.path)} />
          </>
        )}
      </div>
    );
  }
  if (part.name === "file_write" && text(input.path) && text(input.content))
    return (
      <div className="tool-code">
        <p className="tool-code-path">{input.path}{input.replace === true && <span> · replaces the whole file</span>}</p>
        <CodeBlock code={input.content} language={languageOf(input.path)} />
      </div>
    );
  if (part.name === "bash" && text(input.command))
    return <div className="tool-code">
      <p className="tool-code-note">Timeout: {typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : 30} seconds{input.saveLog === true && ' · Save output log'}</p>
      <CodeBlock code={input.command} language="bash" />
    </div>;
  return null;
}
