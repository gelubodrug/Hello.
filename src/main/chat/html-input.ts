import { MAX_HTML_ARTIFACT_BYTES } from '../browser/html-artifacts';

export function htmlSource(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Provide the complete HTML document in browser_show_html({html: "…"}).');
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_HTML_ARTIFACT_BYTES)
    throw new Error('HTML must be UTF-8 text without null bytes, at most 512 KiB. Simplify the visual and use browser_show_html.');
  return value;
}

/** Compatibility at the tool boundary only; native Browser policy still rejects data: URLs. */
export function htmlFromDataURL(value: string): string {
  const match = /^data:text\/html(?:;charset=utf-8)?(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) throw new Error('Use browser_show_html with plain HTML. Only UTF-8 text/html data URLs can be converted to local previews.');
  try {
    const payload = match[2];
    let bytes: Buffer;
    if (match[1]) {
      const encoded = payload.replace(/[\t\n\r ]/g, '');
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw new Error('Invalid base64.');
      bytes = Buffer.from(encoded, 'base64');
    } else {
      // Decode percent bytes without treating literal CSS percentages or # colors as URL syntax.
      const chunks: Buffer[] = [];
      let offset = 0;
      for (const escaped of payload.matchAll(/(?:%[\da-f]{2})+/gi)) {
        chunks.push(Buffer.from(payload.slice(offset, escaped.index), 'utf8'));
        chunks.push(Buffer.from(escaped[0].replace(/%/g, ''), 'hex'));
        offset = escaped.index! + escaped[0].length;
      }
      chunks.push(Buffer.from(payload.slice(offset), 'utf8'));
      bytes = Buffer.concat(chunks);
    }
    return htmlSource(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Invalid or oversized HTML data URL. Use browser_show_html with the plain HTML document (UTF-8, at most 512 KiB); do not repeat this URL.');
  }
}
