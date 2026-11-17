import { decode } from "blurhash";
import { validatedBlurhash } from "../relay/blurhash";

export const BLURHASH_SIZE = 32;

/** Local, bounded raster only; no URL, source-sized canvas or retained cache. */
export function paintBlurhash(
  canvas: HTMLCanvasElement,
  hash: string,
  width = BLURHASH_SIZE,
  height = BLURHASH_SIZE,
): void {
  if (!validatedBlurhash(hash)) return;
  try {
    const context = canvas.getContext("2d");
    if (!context) return;
    const w = Math.min(Math.max(1, Math.round(width)), BLURHASH_SIZE);
    const h = Math.min(Math.max(1, Math.round(height)), BLURHASH_SIZE);
    const image = context.createImageData(w, h);
    image.data.set(decode(hash, w, h));
    context.putImageData(image, 0, 0);
  } catch {
    // Bad metadata, unavailable canvas or decoder failure keeps the frame's
    // existing background. Original loading must never depend on the preview.
  }
}
