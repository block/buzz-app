import { invoke, isTauri } from "@tauri-apps/api/core";

/** WebKit advertises some macOS images as Files with no accessible file. Keep
 * ordinary file, rich-text and text paste on their existing paths. */
export function readUnexposedClipboardImage(
  event: Pick<ClipboardEvent, "isTrusted" | "clipboardData">,
): Promise<File | undefined> | undefined {
  const data = event.clipboardData;
  if (
    !event.isTrusted ||
    data?.types.length !== 1 ||
    data.types[0] !== "Files" ||
    data.items.length ||
    data.files.length ||
    !isTauri() ||
    !/Mac/.test(navigator.platform)
  )
    return;

  return invoke<ArrayBuffer>("clipboard_read_pasted_image").then((png) =>
    png.byteLength
      ? new File([png], "Pasted image.png", { type: "image/png" })
      : undefined,
  );
}
