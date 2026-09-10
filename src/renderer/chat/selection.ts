import type { Message } from '../../shared/types';
import { withSourceLinks, type WebSource } from '../../shared/web';

const allowed = new Set('P DIV SPAN H1 H2 H3 H4 H5 H6 STRONG B EM I DEL S BLOCKQUOTE PRE CODE UL OL LI TABLE THEAD TBODY TR TH TD BR HR A'.split(' '));
const blocks = new Set('P H1 H2 H3 H4 H5 H6 BLOCKQUOTE UL OL TABLE THEAD TBODY TR'.split(' '));

/** Export rendered content, never controls, hidden reasoning or executable HTML. */
function clean(container: HTMLElement): HTMLElement {
  container.querySelectorAll('button,svg,script,style,iframe,img,input,textarea,.code-heading,[hidden],[aria-hidden="true"],[inert]').forEach(node => node.remove());
  for (const node of Array.from(container.querySelectorAll('*')).reverse()) {
    if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
    for (const attribute of Array.from(node.attributes)) {
      if (node.tagName === 'A' && attribute.name === 'href' && !/^(?:\s*(?:javascript|data|vbscript)):|[\u0000-\u001f]/i.test(attribute.value)) continue;
      node.removeAttribute(attribute.name);
    }
  }
  return container;
}

function plain(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return Array.from(node.childNodes).map(plain).join('');
  if (node.tagName === 'PRE') return `\n${node.textContent ?? ''}\n`;
  if (node.tagName === 'BR' || node.tagName === 'HR') return '\n';
  const content = Array.from(node.childNodes).map(plain).join('');
  if (node.tagName === 'LI') {
    const prefix = node.parentElement?.tagName === 'OL'
      ? `${Array.from(node.parentElement.children).indexOf(node) + 1}. ` : '• ';
    return `\n${prefix}${content.trim()}\n`;
  }
  if (node.tagName === 'TD' || node.tagName === 'TH') return `${content}\t`;
  return blocks.has(node.tagName) ? `\n${content}\n` : content;
}

export function chatCopySnapshot(article: HTMLElement, message: Message, sources: readonly WebSource[]) {
  const selection = window.getSelection();
  const selected = selection && !selection.isCollapsed && selection.rangeCount > 0 &&
    article.contains(selection.anchorNode) && article.contains(selection.focusNode);
  const range = selected ? selection.getRangeAt(0).cloneRange() : null;
  const selectedText = selected ? selection.toString() : '';
  const selectedHTML = article.ownerDocument.createElement('div');
  if (range) selectedHTML.append(range.cloneContents());
  const messageHTML = article.ownerDocument.createElement('div');
  if (message.role === 'user') {
    const pre = article.ownerDocument.createElement('pre');
    pre.textContent = message.content;
    messageHTML.append(pre);
  } else {
    // Prose appears in original order, including commentary between tools. A
    // whole-message copy excludes reasoning/tool UI; selection can copy those.
    for (const node of article.querySelectorAll('.markdown')) {
      if (!node.closest('.thinking-part,.tool-part')) messageHTML.append(node.cloneNode(true));
    }
  }
  clean(messageHTML);
  return {
    range,
    selection: { text: selectedText, html: clean(selectedHTML).innerHTML },
    message: { text: withSourceLinks(message.role === 'user' ? message.content : plain(messageHTML).trim(), sources), html: messageHTML.innerHTML },
    markdown: { text: withSourceLinks(message.content, sources) },
  };
}
