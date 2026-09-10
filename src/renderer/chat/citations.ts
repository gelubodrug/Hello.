import type { WebSource } from '../../shared/web';

type Node = { type: string; value?: string; children?: Node[]; url?: string; title?: string; data?: unknown };
/** Transform text nodes only: never rewrite code, links or raw HTML. Unknown
 * IDs remain plain text; URLs always come from real successful fetch results. */
export function citationPlugin(sources: readonly WebSource[]) {
  const byId = new Map(sources.map(source => [source.id, source]));
  return () => (tree: Node) => {
    function visit(node: Node): void {
      if (!node.children || ['link', 'linkReference', 'code', 'inlineCode', 'html', 'image'].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
        const value = child.value;
        const parts: Node[] = [];
        let cursor = 0;
        for (const match of value.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
          const ids = match[1].split(',').map(id => Number(id.trim()));
          if (ids.some(id => !byId.has(id))) continue;
          if (match.index! > cursor) parts.push({ type: 'text', value: value.slice(cursor, match.index) });
          for (const id of ids) {
            const source = byId.get(id)!;
            parts.push({ type: 'link', url: source.url, title: `Source [${id}]: ${source.title}`,
              children: [{ type: 'text', value: `[${id}]` }] });
          }
          cursor = match.index! + match[0].length;
        }
        if (!parts.length) return [child];
        if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
        return parts;
      });
    }
    visit(tree);
  };
}
