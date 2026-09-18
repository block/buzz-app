import { invoke, isTauri } from "@tauri-apps/api/core";
import type { BrowserOpenResult } from "./api";

const MAX_URL_BYTES = 2048;
const encoder = new TextEncoder();

export type UrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * http(s) only, no embedded credentials, and no more than 2048 UTF-8 bytes
 * once normalized — matching the native side's byte-based limit rather than
 * a character count, so Unicode and percent-encoding expansion can't push a
 * URL over the limit on one side of the boundary but not the other.
 */
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

export interface BrowserPlatform {
  readonly available: boolean;
  open(url: string): Promise<BrowserOpenResult>;
}

/** No fallback: outside a desktop build there is no in-app browser surface. */
export function createBrowserPlatform(): BrowserPlatform {
  if (!isTauri()) {
    return {
      available: false,
      async open(): Promise<BrowserOpenResult> {
        return { status: "unavailable" };
      },
    };
  }
  return {
    available: true,
    async open(url): Promise<BrowserOpenResult> {
      const validated = validateBrowsableUrl(url);
      if (!validated.ok)
        return { status: "invalid-url", reason: validated.reason };
      try {
        await invoke("browser_open", { url: validated.url });
        return { status: "opened" };
      } catch (error) {
        return {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
