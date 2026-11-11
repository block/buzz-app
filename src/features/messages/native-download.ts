import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The host validates the URL again and owns the destination; never navigate the webview. */
export async function downloadNativeMedia(source: string, name = "") {
  await invoke("media_download", { source, name });
}

/** Whether the host's last download of this attachment is still where it was saved, unchanged. */
export function savedDownloadStatus(source: string, name = "") {
  return invoke<boolean>("media_download_status", { source, name });
}

/** Opens the saved copy in its default app, or shows it in its folder. The
 * host resolves the path; "moved" means it dropped the record because the
 * file was moved, deleted or changed. */
export async function openSavedDownload(
  source: string,
  name: string,
  reveal: boolean,
): Promise<"opened" | "moved"> {
  try {
    await invoke("media_download_open", { source, name, reveal });
    return "opened";
  } catch (error) {
    if (error === "Saved file moved or changed") return "moved";
    throw error;
  }
}

const subscribers = new Set<() => void>();
let listening = false;
/** Calls back when any window's download changes the host's ledger. One
 * listener serves every card. */
export function subscribeSavedDownloads(callback: () => void) {
  subscribers.add(callback);
  if (!listening) {
    listening = true;
    listen("saved-downloads-changed", () => {
      for (const subscriber of subscribers) subscriber();
    }).catch(() => {
      listening = false;
    });
  }
  return () => {
    subscribers.delete(callback);
  };
}

/** Saves a file the app built to Downloads the way media is saved, and resolves
 * with its path; WKWebView logs a sandbox failure for a `blob:` download. */
export async function downloadNativeFile(file: Blob, name: string) {
  return invoke<string>(
    "file_download",
    new Uint8Array(await file.arrayBuffer()),
    { headers: { "x-buzz-file-name": encodeURIComponent(name) } },
  );
}
