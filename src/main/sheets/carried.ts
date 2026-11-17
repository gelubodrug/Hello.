import JSZip from 'jszip';
import { posix } from 'node:path';

/**
 * Carry the charts of one workbook file into another file of the same workbook.
 *
 * Hello's writer does not know charts: a file it writes has none, and a
 * workbook that holds one could until now only be changed by a script. That
 * made the order of the work a trap — a chart first, and the table beside it
 * could no longer be touched with the tools that make tables. Here the file
 * Hello has just written (`fresh`) takes the drawings of the file that held
 * them (`carrier`): each sheet's drawing, the charts it places and whatever
 * those name, with the relationships and content types that make them part of
 * the package. Sheets are matched by name; a chart whose sheet is gone goes
 * with it.
 *
 * Returns null when it cannot be done without guessing — the fresh file has
 * drawings of its own, a part would land on another of the same name, or a
 * chart is held some way other than by a sheet's drawing (a chart sheet) — so
 * the caller keeps the file it had. `charts` is how many came across: none
 * when every sheet that had one is gone.
 */
const DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** What may follow a sheet's drawing, in the order the format fixes: the drawing goes before the first of them. */
const AFTER_DRAWING = ['legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

const unescape = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const relsOf = (part: string) => `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
const resolve = (from: string, target: string) => target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(from), target));

interface Relationship { id: string; type: string; target: string; external: boolean }
function relationships(xml: string | undefined): Relationship[] {
  const found: Relationship[] = [];
  for (const [tag] of (xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(tag)?.[1], target = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    if (id && target) found.push({ id, target: unescape(target), type: /\bType="([^"]*)"/.exec(tag)?.[1] ?? '', external: /\bTargetMode="External"/.test(tag) });
  }
  return found;
}
/** Sheet name → the part that holds it. */
async function sheetParts(zip: JSZip): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const workbook = await zip.files['xl/workbook.xml']?.async('string');
  if (!workbook) return found;
  const parts = new Map(relationships(await zip.files['xl/_rels/workbook.xml.rels']?.async('string')).map(rel => [rel.id, rel.target]));
  for (const [tag] of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1], rel = /\br:id="([^"]*)"/.exec(tag)?.[1];
    const target = rel && parts.get(rel);
    if (name && target) found.set(unescape(name).toLowerCase(), resolve('xl/workbook.xml', target));
  }
  return found;
}

export async function withCharts(fresh: Uint8Array, carrier: Uint8Array): Promise<{ bytes: Uint8Array; charts: number } | null> {
  let into: JSZip, from: JSZip;
  try { [into, from] = await Promise.all([JSZip.loadAsync(fresh), JSZip.loadAsync(carrier)]); } catch { return null; }
  if (Object.keys(into.files).some(name => /^xl\/(?:drawings|charts)\//.test(name))) return null;
  const types = await into.files['[Content_Types].xml']?.async('string');
  const carried = await from.files['[Content_Types].xml']?.async('string');
  if (!types || !carried) return null;
  const targets = await sheetParts(into);
  const copied = new Set<string>();
  /** A part and everything it names, taken as it is. */
  const take = async (part: string): Promise<boolean> => {
    if (copied.has(part)) return true;
    const entry = from.files[part];
    if (!entry || entry.dir) return true;
    if (into.files[part]) return false;
    copied.add(part);
    into.file(part, await entry.async('uint8array'));
    const rels = from.files[relsOf(part)];
    if (!rels) return true;
    const xml = await rels.async('string');
    into.file(relsOf(part), xml);
    for (const rel of relationships(xml)) if (!rel.external && !(await take(resolve(part, rel.target)))) return false;
    return true;
  };
  const isChart = (part: string) => /^xl\/charts\/chart[^/]*\.xml$/.test(part);
  const placed = new Set<string>();
  for (const [name, part] of await sheetParts(from)) {
    const drawing = relationships(await from.files[relsOf(part)]?.async('string')).find(rel => rel.type === DRAWING && !rel.external);
    if (!drawing) continue;
    for (const rel of relationships(await from.files[relsOf(resolve(part, drawing.target))]?.async('string')))
      if (!rel.external && isChart(resolve(resolve(part, drawing.target), rel.target))) placed.add(resolve(resolve(part, drawing.target), rel.target));
    const target = targets.get(name);
    if (!target) continue;
    const sheet = await into.files[target]?.async('string');
    if (!sheet || /<(?:\w+:)?drawing\b/.test(sheet)) return null;
    const drawingPart = resolve(part, drawing.target);
    if (!from.files[drawingPart]) continue;
    if (!(await take(drawingPart))) return null;
    // The sheet names its drawing by a relationship of its own.
    const existing = await into.files[relsOf(target)]?.async('string');
    const used = relationships(existing).map(rel => Number(/^rId(\d+)$/.exec(rel.id)?.[1] ?? 0));
    const id = `rId${Math.max(0, ...used) + 1}`;
    const line = `<Relationship Id="${id}" Type="${DRAWING}" Target="${posix.relative(posix.dirname(target), drawingPart)}"/>`;
    into.file(relsOf(target), existing && existing.includes('</Relationships>')
      ? existing.replace('</Relationships>', `${line}</Relationships>`)
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELATIONSHIPS}">${line}</Relationships>`);
    const at = AFTER_DRAWING.map(tag => sheet.search(new RegExp(`<(?:\\w+:)?${tag}\\b`))).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? sheet.lastIndexOf('</worksheet>');
    if (at < 0) return null;
    let next = `${sheet.slice(0, at)}<drawing r:id="${id}"/>${sheet.slice(at)}`;
    if (!/<worksheet\b[^>]*\bxmlns:r=/.test(next)) next = next.replace(/<worksheet\b/, `<worksheet xmlns:r="${OFFICE_RELATIONSHIPS}"`);
    into.file(target, next);
  }
  // A chart no sheet's drawing places is held some other way, and that way is not carried here.
  if (Object.keys(from.files).some(name => isChart(name) && !placed.has(name))) return null;
  if (!copied.size) return { bytes: fresh, charts: 0 };
  // Each part says what it is: by its own line where the carrier had one, by its extension otherwise.
  const lines: string[] = [];
  const known = new Set([...types.matchAll(/<Default\b[^>]*\bExtension="([^"]*)"/g)].map(match => match[1].toLowerCase()));
  for (const part of copied) {
    const own = new RegExp(`<Override\\b[^>]*\\bPartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`).exec(carried)?.[0];
    if (own) { lines.push(own); continue; }
    const extension = posix.extname(part).slice(1).toLowerCase();
    if (known.has(extension)) continue;
    const byExtension = new RegExp(`<Default\\b[^>]*\\bExtension="${extension}"[^>]*/>`, 'i').exec(carried)?.[0];
    if (!byExtension) return null;
    known.add(extension);
    lines.push(byExtension);
  }
  into.file('[Content_Types].xml', types.replace('</Types>', `${lines.join('')}</Types>`));
  return { bytes: await into.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), charts: [...copied].filter(isChart).length };
}
