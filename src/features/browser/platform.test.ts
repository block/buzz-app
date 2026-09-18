import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserPlatform, validateBrowsableUrl } from "./platform";

const sdk = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
const native = vi.hoisted(() => ({ value: false }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke: sdk.invoke,
}));
afterEach(() => {
  native.value = false;
  sdk.invoke.mockReset().mockImplementation(async () => undefined);
});

describe("validateBrowsableUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validateBrowsableUrl("https://example.com")).toEqual({
      ok: true,
      url: "https://example.com/",
    });
    expect(validateBrowsableUrl("http://example.com/path?q=1").ok).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(validateBrowsableUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateBrowsableUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("rejects embedded credentials", () => {
    const result = validateBrowsableUrl("https://user:pass@example.com");
    expect(result).toEqual({
      ok: false,
      reason: "URLs with embedded credentials are not supported",
    });
  });

  it("rejects empty, malformed, or oversized input", () => {
    expect(validateBrowsableUrl("").ok).toBe(false);
    expect(validateBrowsableUrl("not a url").ok).toBe(false);
    expect(
      validateBrowsableUrl(`https://example.com/${"a".repeat(3000)}`).ok,
    ).toBe(false);
  });

  it("measures the 2048-byte limit against the normalized UTF-8 form, not raw character count", () => {
    // Each "文" is one UTF-16 code unit but percent-encodes to 9 ASCII bytes
    // once normalized, so raw .length badly undercounts the real size.
    const raw = `https://example.com/#${"文".repeat(300)}`;
    expect(raw.length).toBeLessThan(2048);
    const result = validateBrowsableUrl(raw);
    expect(result).toEqual({ ok: false, reason: "URL exceeds 2048 bytes" });
  });

  it("accepts a raw-character-heavy but byte-bounded Unicode URL", () => {
    const raw = `https://example.com/#${"文".repeat(50)}`;
    const result = validateBrowsableUrl(raw);
    expect(result.ok).toBe(true);
  });
});

describe("createBrowserPlatform", () => {
  it("reports unavailable outside a desktop build, without invoking", async () => {
    native.value = false;
    const platform = createBrowserPlatform();
    expect(platform.available).toBe(false);
    await expect(platform.open("https://example.com")).resolves.toEqual({
      status: "unavailable",
    });
    expect(sdk.invoke).not.toHaveBeenCalled();
  });

  it("validates before invoking on desktop", async () => {
    native.value = true;
    const platform = createBrowserPlatform();
    expect(platform.available).toBe(true);
    await expect(platform.open("javascript:alert(1)")).resolves.toEqual({
      status: "invalid-url",
      reason: "Only http and https URLs are supported",
    });
    expect(sdk.invoke).not.toHaveBeenCalled();
  });

  it("invokes browser_open with the normalized URL on desktop", async () => {
    native.value = true;
    const platform = createBrowserPlatform();
    await expect(platform.open("https://example.com")).resolves.toEqual({
      status: "opened",
    });
    expect(sdk.invoke).toHaveBeenCalledWith("browser_open", {
      url: "https://example.com/",
    });
  });

  it("reports failure when the native call rejects", async () => {
    native.value = true;
    sdk.invoke.mockRejectedValueOnce(new Error("denied"));
    const platform = createBrowserPlatform();
    await expect(platform.open("https://example.com")).resolves.toEqual({
      status: "failed",
      reason: "denied",
    });
  });
});
