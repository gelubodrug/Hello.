// Page modes — the words half. Pure: no Electron, no DOM.
//
// Ported from an earlier design mode (see docs/PROVENANCE.md).
// The page builds what only the page can know (selector, computed styles, the
// React fiber); this module turns it into the text a note becomes, and checks
// everything the page hands back before main believes any of it. A page is
// someone else's code: every field is bounded here, not trusted there.

import type { PageRect } from './types';

/** The line a reference block starts with, so a reader can tell capture from ask. */
export const PAGE_REF_MARK = '⟦Hello-ref⟧';

export interface RefParts {
  /** Component trail on a React development build, e.g. "Sidebar › Row". */
  component?: string | null;
  /** `src/…:line[:column]` from React's debug source, when the build carries it. */
  file?: string | null;
  tag: string;
  text?: string;
  styles?: string;
  /** Short DOM path for a human; the selector is for a machine. */
  dom?: string;
  url?: string;
}

/** PURE: the reference block for one element. Degrades to tag, DOM path and styles off React. */
export function composeRefBlock(parts: RefParts): string {
  const tag = parts.tag || 'element';
  const lines = [
    `${PAGE_REF_MARK} ${parts.component || 'element'} <${tag}>`,
    `file: ${parts.file || '(unknown — not a React development build)'}`,
  ];
  if (parts.text) lines.push(`text: "${parts.text}"`);
  if (parts.styles) lines.push(`style: ${parts.styles}`);
  if (parts.dom) lines.push(`dom:  ${parts.dom}`);
  if (parts.url) lines.push(`page: ${parts.url}`);
  return lines.join('\n');
}

export interface DesignNote {
  /** What the person asked for. */
  text: string;
  /** The reference block built for the element. */
  ref?: string;
  selector: string;
  tag: string;
  url?: string;
  /** Where a picture of the element was saved, when it rides as a path rather than an attachment. */
  shot?: string;
  rect?: PageRect;
  at?: string;
}

/** PURE: the element's reference, then one labelled line with the ask. */
export function composeDesignNote(note: DesignNote): string {
  const head = note.ref ?? [
    `${PAGE_REF_MARK} element <${note.tag || 'element'}>`,
    `dom:  ${note.selector || '(unknown)'}`,
    note.url ? `page: ${note.url}` : null,
  ].filter(Boolean).join('\n');
  const shot = note.shot ? `\nshot: ${note.shot}` : '';
  return `${head}${shot}\nchange: ${note.text.trim()}`;
}

/** PURE: several notes as one paste, numbered in the order they were made. */
export function composeDesignNotes(notes: readonly DesignNote[]): string {
  if (notes.length === 0) return '';
  if (notes.length === 1) return composeDesignNote(notes[0]);
  return notes.map((note, index) => `${index + 1}. ${composeDesignNote(note)}`).join('\n\n---\n\n');
}

/** PURE: notes from a JSON array; anything that is not a note with words is dropped, not guessed at. */
export function parseDesignNotes(raw: string | null | undefined): DesignNote[] {
  const parsed = parseLoose(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((note): note is DesignNote =>
    !!note && typeof note === 'object' &&
    typeof (note as DesignNote).text === 'string' && (note as DesignNote).text.trim().length > 0 &&
    typeof (note as DesignNote).selector === 'string' && typeof (note as DesignNote).tag === 'string');
}

// ── Annotate ─────────────────────────────────────────────────────────────────

export interface AnnotationMark {
  n: number;
  color: string;
  text: string;
  /** What is under the marker: component and source line, or the DOM path. */
  at?: string;
  /** Whether the marker is inside the viewport the picture was taken of. */
  inView?: boolean;
}
export interface AnnotationShot { url: string; marks: AnnotationMark[]; }

/** PURE: a page's annotation list, or null for anything else. */
export function parseAnnotationShot(raw: string | null | undefined): AnnotationShot | null {
  const parsed = parseLoose(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as { url?: unknown; marks?: unknown };
  if (!Array.isArray(value.marks)) return null;
  const marks = value.marks.filter((mark): mark is AnnotationMark =>
    !!mark && typeof mark === 'object' &&
    typeof (mark as AnnotationMark).n === 'number' &&
    typeof (mark as AnnotationMark).text === 'string' && (mark as AnnotationMark).text.trim().length > 0);
  return { url: typeof value.url === 'string' ? value.url : '', marks };
}

/** PURE: the text beside an annotated picture. Each line names number and colour, so it survives losing the image. */
export function composeAnnotations(shot: AnnotationShot, picturePath: string | null): string {
  const count = shot.marks.length;
  const lines = [`⟦Hello-annotations⟧ ${count} ${count === 1 ? 'marker' : 'markers'}${shot.url ? ` on ${shot.url}` : ''}`];
  if (picturePath) lines.push(`shot: ${picturePath}`);
  for (const mark of [...shot.marks].sort((a, b) => a.n - b.n)) {
    let line = `#${mark.n} ${mark.color} — ${mark.text.trim()}`;
    if (mark.at) line += ` · at ${mark.at}`;
    if (mark.inView === false) line += ' · outside the picture';
    lines.push(line);
  }
  return lines.join('\n');
}

// ── What the page hands back ─────────────────────────────────────────────────

/** One element the person clicked, as the page described it. */
export interface ProbePick {
  type: 'pick';
  /** Names the element for the one follow-up read that can see the page's own scripts. */
  token: string;
  tag: string; selector: string; text: string; styles: string; dom: string; url: string;
  rect: PageRect; point: { x: number; y: number }; viewport: { w: number; h: number };
}
export type ProbeEvent =
  | ProbePick
  | { type: 'hover'; rect: PageRect | null }
  | { type: 'released' }
  /** Annotate: how many committed markers the page holds; `mark` names a new one whose element main may read once. */
  | { type: 'marks'; count: number; mark?: { n: number; token: string } };
export interface ProbeBatch { armId: string; events: ProbeEvent[]; }

const LIMITS = { tag: 40, selector: 1000, text: 200, styles: 600, dom: 400, url: 8192, token: 64, events: 60, marks: 500, note: 1000, at: 600 } as const;
const CONTROL = /[\x00-\x1f\x7f]/g;
const bounded = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(CONTROL, ' ').slice(0, limit) : '';
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(-1e6, Math.min(1e6, Math.round(value))) : null;

/** PURE: a rect in page CSS pixels, or null when any side is not a number. */
export function parseRect(value: unknown): PageRect | null {
  if (!value || typeof value !== 'object') return null;
  const box = value as Record<string, unknown>;
  const [x, y, w, h] = [finite(box.x), finite(box.y), finite(box.w), finite(box.h)];
  if (x === null || y === null || w === null || h === null || w < 0 || h < 0) return null;
  return { x, y, w, h };
}

/** PURE: one batch from the page, every field checked and bounded. Null when it is not one. */
export function parseProbeBatch(value: unknown): ProbeBatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const batch = value as { armId?: unknown; events?: unknown };
  if (typeof batch.armId !== 'string' || !batch.armId || batch.armId.length > 100 || !Array.isArray(batch.events)) return null;
  const events: ProbeEvent[] = [];
  for (const raw of batch.events.slice(-LIMITS.events)) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    if (event.type === 'released') events.push({ type: 'released' });
    else if (event.type === 'marks') {
      const count = finite(event.count);
      if (count === null || count < 0 || count > LIMITS.marks) continue;
      const mark = event.mark as Record<string, unknown> | undefined;
      const n = finite(mark?.n), token = bounded(mark?.token, LIMITS.token);
      events.push(mark && n !== null && n > 0 && /^[a-z0-9]+$/i.test(token)
        ? { type: 'marks', count, mark: { n, token } }
        : { type: 'marks', count });
    }
    else if (event.type === 'hover') events.push({ type: 'hover', rect: event.rect === null ? null : parseRect(event.rect) });
    else if (event.type === 'pick') {
      const rect = parseRect(event.rect);
      const point = event.point as Record<string, unknown> | undefined;
      const viewport = event.viewport as Record<string, unknown> | undefined;
      const px = finite(point?.x), py = finite(point?.y), vw = finite(viewport?.w), vh = finite(viewport?.h);
      const token = bounded(event.token, LIMITS.token);
      if (!rect || px === null || py === null || !vw || !vh || vw <= 0 || vh <= 0 || !/^[a-z0-9]+$/i.test(token)) continue;
      events.push({
        type: 'pick', token,
        tag: bounded(event.tag, LIMITS.tag).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'element',
        selector: bounded(event.selector, LIMITS.selector),
        text: bounded(event.text, LIMITS.text),
        styles: bounded(event.styles, LIMITS.styles),
        dom: bounded(event.dom, LIMITS.dom),
        url: bounded(event.url, LIMITS.url),
        rect, point: { x: px, y: py }, viewport: { w: vw, h: vh },
      });
    }
  }
  return { armId: batch.armId, events };
}

const MARK_COLORS = new Set(['yellow', 'blue', 'pink', 'green', 'orange', 'purple']);

/**
 * PURE: the markers a page reported for its picture, every field checked and
 * bounded. The address is not the page's to give: `url` is main's.
 */
export function parseProbeAnnotations(value: unknown, url: string): AnnotationShot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const list = (value as { marks?: unknown }).marks;
  if (!Array.isArray(list)) return null;
  const marks: AnnotationMark[] = [];
  const seen = new Set<number>();
  for (const raw of list.slice(0, LIMITS.marks)) {
    if (!raw || typeof raw !== 'object') continue;
    const mark = raw as Record<string, unknown>;
    const n = finite(mark.n);
    const text = bounded(mark.text, LIMITS.note).trim();
    if (n === null || n < 1 || seen.has(n) || !text) continue;
    seen.add(n);
    const at = bounded(mark.at, LIMITS.at).trim();
    marks.push({
      n, text,
      color: typeof mark.color === 'string' && MARK_COLORS.has(mark.color) ? mark.color : 'marker',
      ...(at ? { at } : {}),
      ...(typeof mark.inView === 'boolean' ? { inView: mark.inView } : {}),
    });
  }
  return { url: bounded(url, LIMITS.url), marks };
}

/** PURE: what the page's own scripts said about the element — component trail and source line. */
export function parseFiberInfo(value: unknown): { component: string | null; file: string | null } {
  if (!value || typeof value !== 'object') return { component: null, file: null };
  const info = value as { component?: unknown; file?: unknown };
  const clean = (text: unknown, limit: number) =>
    typeof text === 'string' && text.trim() ? text.replace(CONTROL, ' ').trim().slice(0, limit) : null;
  return { component: clean(info.component, 160), file: clean(info.file, 400) };
}

/**
 * PURE: the pixel box of `rect` inside a capture of the whole viewport. The
 * ratio comes from the picture itself, so page zoom and display density both
 * fall out of it. Null when nothing of the rect is on screen.
 */
export function cropBox(rect: PageRect, viewport: { w: number; h: number }, image: { width: number; height: number }):
  { x: number; y: number; width: number; height: number } | null {
  if (viewport.w <= 0 || viewport.h <= 0 || image.width <= 0 || image.height <= 0) return null;
  const sx = image.width / viewport.w, sy = image.height / viewport.h;
  const left = Math.max(0, Math.floor(rect.x * sx));
  const top = Math.max(0, Math.floor(rect.y * sy));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.w) * sx));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.h) * sy));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function parseLoose(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    let parsed: unknown = JSON.parse(raw);
    // A payload wrapped one layer too deep still counts.
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed;
  } catch {
    return null;
  }
}
