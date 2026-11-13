import { invoke, isTauri } from "@tauri-apps/api/core";

export type PointingShot = { file: File; atMs: number };
type Rect = { x: number; y: number; width: number; height: number };

/** Capture pixels at pointing time, rather than reconstructing the UI after recording. */
export async function pointedScreenshot(
  element: HTMLElement,
  pointer: { x: number; y: number },
  atMs: number,
): Promise<PointingShot> {
  if (!isTauri()) throw new Error("Screenshots require Mac desktop.");
  const bounds = element.getBoundingClientRect();
  if (!element.isConnected || bounds.width <= 0 || bounds.height <= 0)
    throw new Error("The pointed-at item is no longer visible.");
  const width = Math.min(
    window.innerWidth,
    1280,
    Math.max(320, bounds.width + 48),
  );
  const height = Math.min(
    window.innerHeight,
    960,
    Math.max(180, bounds.height + 48),
  );
  const centerX =
    bounds.width + 48 > width ? pointer.x : bounds.left + bounds.width / 2;
  const centerY =
    bounds.height + 48 > height ? pointer.y : bounds.top + bounds.height / 2;
  const crop: Rect = {
    x: Math.max(0, Math.min(window.innerWidth - width, centerX - width / 2)),
    y: Math.max(0, Math.min(window.innerHeight - height, centerY - height / 2)),
    width,
    height,
  };
  const redactions = Array.from(
    document.querySelectorAll(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ),
  ).flatMap((editor): Rect[] => {
    const rect = editor.getBoundingClientRect();
    const x = Math.max(crop.x, rect.left),
      y = Math.max(crop.y, rect.top);
    const right = Math.min(crop.x + crop.width, rect.right);
    const bottom = Math.min(crop.y + crop.height, rect.bottom);
    return right > x && bottom > y
      ? [{ x, y, width: right - x, height: bottom - y }]
      : [];
  });
  const bytes = await invoke<ArrayBuffer>("window_snapshot", {
    crop,
    redactions,
  });
  return {
    atMs,
    file: new File([bytes], `pointed-at-${(atMs / 1000).toFixed(2)}s.png`, {
      type: "image/png",
    }),
  };
}

export function screenshotSummary(shots: readonly PointingShot[]) {
  return shots.length
    ? `Voice note with ${shots.length === 1 ? "a screenshot" : `${shots.length} screenshots`} of what I pointed at.\n${shots.map((shot, i) => `Image ${i + 1}: ${(shot.atMs / 1000).toFixed(2)}s into the voice note.`).join("\n")}`
    : "Voice note";
}
