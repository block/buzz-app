import { invoke, isTauri } from "@tauri-apps/api/core";
import { imageType } from "../relay/attachment-limits";

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

  return invoke<ArrayBuffer>("clipboard_read_pasted_image").then((image) => {
    const type = imageType(new Uint8Array(image));
    if (type === "image/png")
      return new File([image], "Pasted image.png", { type });
    if (type === "image/jpeg")
      return new File([image], "Pasted image.jpg", { type });
  });
}
