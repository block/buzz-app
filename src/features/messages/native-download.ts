import { invoke } from "@tauri-apps/api/core";

/** The host validates the URL again and owns the destination; never navigate the webview. */
export async function downloadNativeMedia(source: string, name = "") {
  await invoke("media_download", { source, name });
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

/** Artwork the app serves from its own origin: WebKit's download cannot fetch
 * that origin, so load it here, where the page already loaded it, and save it
 * through the host like other media. */
export async function downloadAppArtwork(source: string, name: string) {
  const response = await fetch(source);
  if (!response.ok)
    throw new Error(`Could not load artwork (${response.status})`);
  await downloadNativeFile(await response.blob(), name);
}
