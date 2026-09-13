import { describe, expect, it } from 'vitest';
import type { NativeImage } from 'electron';
import {
  SCREENSHOT_FRAME_BYTES,
  checkPointerInViewport,
  checkRegionInViewport,
  encodeFrame,
  parsePointerAction,
  parseScreenshotRequest,
  pointerEvents,
} from '../src/main/browser/agent-input';

/** Enough of a NativeImage to follow what was cropped, resized and encoded. */
class Picture {
  constructor(readonly width: number, readonly height: number, readonly pngBytes = 1000, readonly jpegBytes = 500,
    readonly box: unknown = null) {}
  getSize = () => ({ width: this.width, height: this.height });
  isEmpty = () => this.width === 0;
  crop = (box: { x: number; y: number; width: number; height: number }) =>
    new Picture(box.width, box.height, this.pngBytes, this.jpegBytes, box);
  resize = ({ width, height }: { width?: number; height?: number }) => {
    const w = width ?? Math.round(this.width * height! / this.height);
    const h = height ?? Math.round(this.height * width! / this.width);
    const area = (w * h) / (this.width * this.height);
    return new Picture(w, h, Math.floor(this.pngBytes * area), Math.floor(this.jpegBytes * area), this.box);
  };
  toPNG = () => Buffer.alloc(this.pngBytes, 1);
  toJPEG = () => Buffer.alloc(this.jpegBytes, 2);
}
const image = (picture: Picture) => picture as unknown as NativeImage;
const viewport = { width: 800, height: 600 };

describe('pointer arguments', () => {
  it('fills defaults and refuses what is not a finite position or a bounded drag', () => {
    expect(parsePointerAction({ action: 'click', x: 10, y: 20 }))
      .toEqual({ action: 'click', x: 10, y: 20, button: 'left', clickCount: 1 });
    expect(parsePointerAction({ action: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }))
      .toEqual({ action: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, steps: 12, durationMs: 300 });
    expect(() => parsePointerAction({ action: 'click', x: Number.NaN, y: 1 })).toThrow(/x must be a finite number/);
    expect(() => parsePointerAction({ action: 'hover', x: '5', y: 1 })).toThrow(/x must be/);
    expect(() => parsePointerAction({ action: 'click', x: 1, y: 1, button: 'middle' })).toThrow(/left or right/);
    expect(() => parsePointerAction({ action: 'click', x: 1, y: 1, clickCount: 3 })).toThrow(/clickCount/);
    expect(() => parsePointerAction({ action: 'drag', from: { x: 1, y: 1 }, to: { x: 2 } })).toThrow(/to\.y/);
    expect(() => parsePointerAction({ action: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, steps: 1 })).toThrow(/steps/);
    expect(() => parsePointerAction({ action: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, steps: 61 })).toThrow(/steps/);
    expect(() => parsePointerAction({ action: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, durationMs: 3001 })).toThrow(/durationMs/);
    expect(() => parsePointerAction({ action: 'wheel' })).toThrow(/click, hover or drag/);
  });

  it('requires every point inside the viewport, and says how large it is', () => {
    expect(() => checkPointerInViewport({ action: 'hover', x: 799, y: 599 }, viewport)).not.toThrow();
    expect(() => checkPointerInViewport({ action: 'hover', x: 800, y: 10 }, viewport)).toThrow(/800x600 CSS px/);
    expect(() => checkPointerInViewport({ action: 'click', x: -1, y: 10, button: 'left', clickCount: 1 }, viewport)).toThrow(/outside/);
    expect(() => checkPointerInViewport(
      { action: 'drag', from: { x: 10, y: 10 }, to: { x: 10, y: 600 }, steps: 2, durationMs: 0 }, viewport)).toThrow(/outside/);
  });

  it('plans a drag as move, button down, every intermediate move with the button held, button up', () => {
    const events = pointerEvents({ action: 'drag', from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, steps: 4, durationMs: 200 });
    expect(events.map(({ event }) => event.type)).toEqual(
      ['mouseMove', 'mouseDown', 'mouseMove', 'mouseMove', 'mouseMove', 'mouseMove', 'mouseUp']);
    expect(events[1].event).toMatchObject({ x: 0, y: 0, button: 'left', clickCount: 1 });
    expect(events.slice(2, 6).map(({ event }) => [event.x, event.y])).toEqual([[25, 13], [50, 25], [75, 38], [100, 50]]);
    for (const { event, delayMs } of events.slice(2, 6)) {
      expect(event).toMatchObject({ button: 'left', modifiers: ['leftbuttondown'] });
      expect(delayMs).toBe(50);
    }
    expect(events[6].event).toMatchObject({ type: 'mouseUp', x: 100, y: 50, button: 'left' });
  });

  it('scales CSS pixels by the page zoom and sends a double click as two counted presses', () => {
    const events = pointerEvents({ action: 'click', x: 10, y: 20, button: 'right', clickCount: 2 }, 1.5);
    expect(events.map(({ event }) => [event.type, event.x, event.y, event.button, event.clickCount])).toEqual([
      ['mouseMove', 15, 30, undefined, undefined],
      ['mouseDown', 15, 30, 'right', 1], ['mouseUp', 15, 30, 'right', 1],
      ['mouseDown', 15, 30, 'right', 2], ['mouseUp', 15, 30, 'right', 2],
    ]);
    expect(pointerEvents({ action: 'hover', x: 3, y: 4 }).map(({ event }) => event))
      .toEqual([{ type: 'mouseMove', x: 3, y: 4 }]);
  });
});

describe('screenshot arguments and pictures', () => {
  it('bounds frames, interval and region', () => {
    expect(parseScreenshotRequest({})).toEqual({ frames: 1, intervalMs: 500 });
    expect(parseScreenshotRequest({ frames: 4, intervalMs: 100, region: { x: 0, y: 0, width: 10, height: 10 } }))
      .toEqual({ frames: 4, intervalMs: 100, region: { x: 0, y: 0, width: 10, height: 10 } });
    expect(() => parseScreenshotRequest({ frames: 0 })).toThrow(/frames/);
    expect(() => parseScreenshotRequest({ frames: 5 })).toThrow(/frames/);
    expect(() => parseScreenshotRequest({ intervalMs: 99 })).toThrow(/intervalMs/);
    expect(() => parseScreenshotRequest({ intervalMs: 2001 })).toThrow(/intervalMs/);
    expect(() => parseScreenshotRequest({ region: { x: 0, y: 0, width: 0, height: 5 } })).toThrow(/at least 1/);
    expect(() => parseScreenshotRequest({ region: { x: 0, y: 0, width: Infinity, height: 5 } })).toThrow(/finite/);
    expect(() => checkRegionInViewport({ x: 700, y: 0, width: 101, height: 5 }, viewport)).toThrow(/800x600/);
    expect(() => checkRegionInViewport({ x: 700, y: 0, width: 100, height: 600 }, viewport)).not.toThrow();
  });

  it('downscales the longest side to 1280 px and keeps PNG while it fits', () => {
    const frame = encodeFrame(image(new Picture(3200, 2400)), { width: 1600, height: 1200 });
    expect(frame).toMatchObject({ mimeType: 'image/png', width: 1280, height: 960 });
    expect(Buffer.from(frame.data, 'base64')[0]).toBe(1);
    const tall = encodeFrame(image(new Picture(1000, 4000)), { width: 500, height: 2000 });
    expect(tall).toMatchObject({ width: 320, height: 1280 });
  });

  it('crops a region in CSS px through the device scale, before downscaling', () => {
    const frame = encodeFrame(image(new Picture(1600, 1200)), viewport, { x: 100, y: 50, width: 200, height: 100 });
    expect(frame).toMatchObject({ width: 400, height: 200 });
  });

  it('falls back to JPEG, then shrinks, to stay within the byte budget', () => {
    const jpeg = encodeFrame(image(new Picture(1000, 1000, SCREENSHOT_FRAME_BYTES * 2, 1000)), viewport);
    expect(jpeg).toMatchObject({ mimeType: 'image/jpeg', width: 1000 });
    const shrunk = encodeFrame(image(new Picture(1000, 1000, SCREENSHOT_FRAME_BYTES * 8, SCREENSHOT_FRAME_BYTES * 2)), viewport);
    expect(shrunk.mimeType).toBe('image/jpeg');
    expect(shrunk.width).toBeLessThan(1000);
    expect(Buffer.from(shrunk.data, 'base64').length).toBeLessThanOrEqual(SCREENSHOT_FRAME_BYTES);
  });
});
