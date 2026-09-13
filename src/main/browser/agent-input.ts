import type { MouseInputEvent, NativeImage } from "electron";
import { cropBox } from "../../shared/page-mode-format";

/**
 * What an agent may send a page with the pointer, and how it may look at it.
 * Pure: arguments are checked and events planned here; the browser manager
 * decides whether the tab may receive them and sends them to the guest.
 */
export interface PagePoint { x: number; y: number }
export type PointerAction =
  | { action: "click"; x: number; y: number; button: "left" | "right"; clickCount: 1 | 2 }
  | { action: "hover"; x: number; y: number }
  | { action: "drag"; from: PagePoint; to: PagePoint; steps: number; durationMs: number };
export interface PageRegion { x: number; y: number; width: number; height: number }
export interface ScreenshotRequest { region?: PageRegion; frames: number; intervalMs: number }
export interface ScreenshotFrame { mimeType: "image/png" | "image/jpeg"; data: string; width: number; height: number }
export interface Screenshot { frames: ScreenshotFrame[]; viewport: { width: number; height: number } }

export const POINTER_STEPS = { min: 2, max: 60, default: 12 } as const;
export const POINTER_MAX_DURATION_MS = 3000;
export const SCREENSHOT_FRAMES = { min: 1, max: 4 } as const;
export const SCREENSHOT_INTERVAL_MS = { min: 100, max: 2000, default: 500 } as const;
export const SCREENSHOT_LONGEST_SIDE = 1280;
/** Per picture, before base64. Four of them still fit the tool bridge with room. */
export const SCREENSHOT_FRAME_BYTES = 1024 * 1024;
/** Not the page's world, where a script could redefine what the viewport says. */
export const AGENT_INPUT_WORLD_ID = 1208;
export const VIEWPORT_SCRIPT = "({w:window.innerWidth,h:window.innerHeight})";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a finite number of CSS pixels.`);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function point(value: unknown, name: string): PagePoint {
  if (!object(value)) throw new Error(`${name} must be an object with x and y.`);
  return { x: finite(value.x, `${name}.x`), y: finite(value.y, `${name}.y`) };
}

export function parsePointerAction(input: Record<string, unknown>): PointerAction {
  switch (input.action) {
    case "click": {
      if (input.button !== undefined && input.button !== "left" && input.button !== "right")
        throw new Error("button must be left or right.");
      return {
        action: "click", x: finite(input.x, "x"), y: finite(input.y, "y"),
        button: input.button === "right" ? "right" : "left",
        clickCount: integer(input.clickCount, "clickCount", 1, 2, 1) as 1 | 2,
      };
    }
    case "hover":
      return { action: "hover", x: finite(input.x, "x"), y: finite(input.y, "y") };
    case "drag":
      return {
        action: "drag", from: point(input.from, "from"), to: point(input.to, "to"),
        steps: integer(input.steps, "steps", POINTER_STEPS.min, POINTER_STEPS.max, POINTER_STEPS.default),
        durationMs: integer(input.durationMs, "durationMs", 0, POINTER_MAX_DURATION_MS, 300),
      };
    default:
      throw new Error("action must be click, hover or drag.");
  }
}

export function parseScreenshotRequest(input: Record<string, unknown>): ScreenshotRequest {
  const frames = integer(input.frames, "frames", SCREENSHOT_FRAMES.min, SCREENSHOT_FRAMES.max, 1);
  const intervalMs = integer(input.intervalMs, "intervalMs", SCREENSHOT_INTERVAL_MS.min,
    SCREENSHOT_INTERVAL_MS.max, SCREENSHOT_INTERVAL_MS.default);
  if (input.region === undefined) return { frames, intervalMs };
  if (!object(input.region)) throw new Error("region must be an object with x, y, width and height.");
  const region = {
    x: finite(input.region.x, "region.x"), y: finite(input.region.y, "region.y"),
    width: finite(input.region.width, "region.width"), height: finite(input.region.height, "region.height"),
  };
  if (region.width < 1 || region.height < 1) throw new Error("region width and height must be at least 1 CSS pixel.");
  return { region, frames, intervalMs };
}

const inside = (p: PagePoint, viewport: Screenshot["viewport"]) =>
  p.x >= 0 && p.y >= 0 && p.x < viewport.width && p.y < viewport.height;
const size = (viewport: Screenshot["viewport"]) => `${viewport.width}x${viewport.height}`;

/** Every point must be on the page as it is now; nothing is clamped into it. */
export function checkPointerInViewport(action: PointerAction, viewport: Screenshot["viewport"]): void {
  const points = action.action === "drag" ? [action.from, action.to] : [action];
  for (const p of points)
    if (!inside(p, viewport))
      throw new Error(`(${p.x}, ${p.y}) is outside this tab's viewport, which is ${size(viewport)} CSS px; x must be 0 to ${viewport.width - 1} and y 0 to ${viewport.height - 1}.`);
}

export function checkRegionInViewport(region: PageRegion, viewport: Screenshot["viewport"]): void {
  if (region.x < 0 || region.y < 0 || region.x + region.width > viewport.width || region.y + region.height > viewport.height)
    throw new Error(`The region does not fit this tab's viewport, which is ${size(viewport)} CSS px.`);
}

export interface PlannedInput { event: MouseInputEvent; delayMs: number }

/**
 * The native events for one action, in page CSS pixels scaled by the page's
 * zoom into the guest's own coordinates. A drag holds the button through
 * every intermediate move, so pointer, drag and inertia handlers all run.
 */
export function pointerEvents(action: PointerAction, zoom = 1): PlannedInput[] {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const at = (p: PagePoint) => ({ x: Math.round(p.x * scale), y: Math.round(p.y * scale) });
  const now = (event: MouseInputEvent, delayMs = 0): PlannedInput => ({ event, delayMs });
  if (action.action === "hover") return [now({ type: "mouseMove", ...at(action) })];
  if (action.action === "click") {
    const { button } = action;
    const events = [now({ type: "mouseMove", ...at(action) })];
    for (let count = 1; count <= action.clickCount; count++)
      events.push(
        now({ type: "mouseDown", ...at(action), button, clickCount: count }),
        now({ type: "mouseUp", ...at(action), button, clickCount: count }),
      );
    return events;
  }
  const { from, to, steps, durationMs } = action;
  const delayMs = durationMs / steps;
  const events = [
    now({ type: "mouseMove", ...at(from) }),
    now({ type: "mouseDown", ...at(from), button: "left", clickCount: 1 }),
  ];
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    events.push(now({
      type: "mouseMove", ...at({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }),
      button: "left", modifiers: ["leftbuttondown"],
    }, delayMs));
  }
  events.push(now({ type: "mouseUp", ...at(to), button: "left", clickCount: 1 }));
  return events;
}

/**
 * One captured picture, cut to `region` when given, no longer than
 * SCREENSHOT_LONGEST_SIDE on its longest side, and within the byte budget:
 * PNG while it fits, since canvas work is about exact pixels, then JPEG.
 */
export function encodeFrame(image: NativeImage, viewport: Screenshot["viewport"], region?: PageRegion): ScreenshotFrame {
  let picture = image;
  if (region) {
    const crop = cropBox({ x: region.x, y: region.y, w: region.width, h: region.height },
      { w: viewport.width, h: viewport.height }, image.getSize());
    if (!crop) throw new Error("The region is outside the captured page.");
    picture = image.crop(crop);
  }
  const shrink = (factor: number) => {
    const { width, height } = picture.getSize();
    picture = width >= height
      ? picture.resize({ width: Math.max(1, Math.floor(width * factor)), quality: "good" })
      : picture.resize({ height: Math.max(1, Math.floor(height * factor)), quality: "good" });
  };
  const longest = () => Math.max(picture.getSize().width, picture.getSize().height);
  if (longest() > SCREENSHOT_LONGEST_SIDE) shrink(SCREENSHOT_LONGEST_SIDE / longest());
  const done = (mimeType: ScreenshotFrame["mimeType"], bytes: Buffer): ScreenshotFrame =>
    ({ mimeType, data: bytes.toString("base64"), ...picture.getSize() });
  const png = picture.toPNG();
  if (png.length <= SCREENSHOT_FRAME_BYTES) return done("image/png", png);
  let jpeg = picture.toJPEG(80);
  while (jpeg.length > SCREENSHOT_FRAME_BYTES && longest() > 64) {
    shrink(0.7);
    jpeg = picture.toJPEG(80);
  }
  if (jpeg.length > SCREENSHOT_FRAME_BYTES) throw new Error("The picture could not be made small enough to return.");
  return done("image/jpeg", jpeg);
}

/** A pause the run's Stop ends at once. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error("Browser operation stopped.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
