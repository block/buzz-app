import { invoke, isTauri } from "@tauri-apps/api/core";
import { validateBrowsableUrl } from "../browser/platform";

/** What a link shows when `openInBrowser` resolves false. */
export const OPEN_IN_BROWSER_FAILED = "Couldn’t open the link in your browser.";

/** Opens a link outside Buzz: the system browser in the desktop app, a new
 * tab on the web. It takes the URLs the in-app browser takes, normalized the
 * same way, and resolves false when it rejects the URL or the system opener
 * refuses. */
export async function openInBrowser(url: string): Promise<boolean> {
  const checked = validateBrowsableUrl(url);
  if (!checked.ok) return false;
  if (!isTauri()) {
    window.open(checked.url, "_blank", "noopener,noreferrer");
    return true;
  }
  try {
    await invoke("plugin:opener|open_url", { url: checked.url });
    return true;
  } catch {
    return false;
  }
}
