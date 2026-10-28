import { invoke, isTauri } from "@tauri-apps/api/core";
const MAX_URL_BYTES = 2048;
const encoder = new TextEncoder();

export type UrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export function validateBrowsableUrl(url: string): UrlValidation {
  if (typeof url !== "string" || !url)
    return { ok: false, reason: "A URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Malformed URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: "Only http and https URLs are supported" };
  if (parsed.username || parsed.password)
    return {
      ok: false,
      reason: "URLs with embedded credentials are not supported",
    };
  const normalized = parsed.toString();
  if (encoder.encode(normalized).length > MAX_URL_BYTES)
    return { ok: false, reason: `URL exceeds ${MAX_URL_BYTES} bytes` };
  return { ok: true, url: normalized };
}

export type BrowserBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type BrowserStatus = Readonly<{
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  control_granted?: boolean;
  control_revision?: number;
}>;

export type BrowserAction = "back" | "forward" | "reload";

export interface BrowserPlatform {
  readonly available: boolean;
  attach(url: string, bounds: BrowserBounds, storage?: string): Promise<string>;
  setBounds(
    sessionId: string,
    bounds: BrowserBounds,
    visible: boolean,
  ): Promise<void>;
  navigate(sessionId: string, url: string): Promise<void>;
  action(sessionId: string, action: BrowserAction): Promise<void>;
  status(sessionId: string): Promise<BrowserStatus>;
  detach(sessionId: string): Promise<void>;
  control?: BrowserControl;
}

export type BrowserControlRequest =
  | { action: "observe" }
  | { action: "navigate"; url: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; text: string };

export type BrowserControlGrant = Readonly<{ token: string; revision: number }>;

export interface BrowserControl {
  available(): Promise<boolean>;
  grant(sessionId: string): Promise<BrowserControlGrant>;
  revoke(sessionId: string): Promise<void>;
  execute(token: string, request: BrowserControlRequest): Promise<unknown>;
}

function normalizedUrl(url: string): string {
  const validation = validateBrowsableUrl(url);
  if (!validation.ok) throw new Error(validation.reason);
  return validation.url;
}

export function createBrowserPlatform(): BrowserPlatform {
  const available =
    isTauri() &&
    typeof navigator !== "undefined" &&
    /Mac/i.test(navigator.platform);
  return {
    available,
    attach: async (url, bounds, storage) =>
      invoke<string>("browser_attach", {
        url: normalizedUrl(url),
        bounds,
        storage: storage ?? null,
      }),
    setBounds: (sessionId, bounds, visible) =>
      invoke("browser_set_bounds", { sessionId, bounds, visible }),
    navigate: async (sessionId, url) =>
      invoke("browser_navigate", { sessionId, url: normalizedUrl(url) }),
    action: (sessionId, action) =>
      invoke("browser_action", { sessionId, action }),
    status: (sessionId) =>
      invoke<BrowserStatus>("browser_status", { sessionId }),
    detach: (sessionId) => invoke("browser_detach", { sessionId }),
    control: {
      available: async () =>
        available && invoke<boolean>("browser_control_available"),
      grant: (sessionId) =>
        invoke<BrowserControlGrant>("browser_control_grant", { sessionId }),
      revoke: (sessionId) => invoke("browser_control_revoke", { sessionId }),
      execute: (token, request) =>
        invoke("browser_control_execute", { token, request }),
    },
  };
}
