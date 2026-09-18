import { invoke } from "@tauri-apps/api/core";

export type BrowserStatus = Readonly<{
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
}>;

export type BrowserAction = "back" | "forward" | "reload";

export function fetchBrowserStatus(): Promise<BrowserStatus> {
  return invoke("browser_status");
}

export function navigateBrowser(url: string): Promise<void> {
  return invoke("browser_navigate", { url });
}

export function performBrowserAction(action: BrowserAction): Promise<void> {
  return invoke("browser_action", { action });
}
