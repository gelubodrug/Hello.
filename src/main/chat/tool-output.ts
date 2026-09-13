// What a Hello tool hands back to the model: text, or text with pictures.
// Shared by both ends of the Pi tool bridge — main, and the Pi child the
// extension runs in — so this file imports nothing.

export interface ToolImage {
  mimeType: 'image/png' | 'image/jpeg';
  /** Base64, never a local path. */
  data: string;
}
export interface ToolImageResult {
  text: string;
  images: ToolImage[];
}
export type ToolOutput = string | ToolImageResult;

export const MAX_TOOL_IMAGES = 4;
/** Base64 characters per picture: about 1.5 MiB of image. */
export const MAX_TOOL_IMAGE_CHARS = 2 * 1024 * 1024;
/** All pictures together, well inside the bridge's 8 MiB body. */
export const MAX_TOOL_IMAGES_CHARS = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 64 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A tool result as it may cross the bridge, or an error naming why it may not. */
export function readToolOutput(value: unknown): ToolOutput {
  if (typeof value === 'string') return value;
  const invalid = () => new Error('Hello tool bridge returned an invalid result.');
  if (!object(value) || typeof value.text !== 'string' || value.text.length > MAX_TEXT_CHARS ||
      !Array.isArray(value.images) || !value.images.length || value.images.length > MAX_TOOL_IMAGES)
    throw invalid();
  let total = 0;
  const images = value.images.map((image): ToolImage => {
    if (!object(image) || (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') ||
        typeof image.data !== 'string' || !image.data || image.data.length > MAX_TOOL_IMAGE_CHARS ||
        image.data.length % 4 !== 0 || !BASE64.test(image.data))
      throw invalid();
    total += image.data.length;
    return { mimeType: image.mimeType, data: image.data };
  });
  if (total > MAX_TOOL_IMAGES_CHARS) throw new Error('Hello tool pictures exceed the bridge size limit.');
  return { text: value.text, images };
}

/** The words of a result: what a transcript keeps, without any picture data. */
export function toolOutputText(output: ToolOutput): string {
  return typeof output === 'string' ? output : output.text;
}
