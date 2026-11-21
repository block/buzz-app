// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/core", () => tauri);
import { openInBrowser } from "./open-in-browser";

afterEach(() => {
  vi.restoreAllMocks();
  tauri.isTauri.mockReset().mockReturnValue(false);
  tauri.invoke.mockReset().mockResolvedValue(undefined);
});

it("opens a normalized link in a new tab on the web", async () => {
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  expect(await openInBrowser("https://Docs.example")).toBe(true);
  expect(opened).toHaveBeenCalledExactlyOnceWith(
    "https://docs.example/",
    "_blank",
    "noopener,noreferrer",
  );
});

it("opens it with the system opener in the desktop app", async () => {
  tauri.isTauri.mockReturnValue(true);
  expect(await openInBrowser("https://docs.example/a?b=c#d")).toBe(true);
  expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith(
    "plugin:opener|open_url",
    { url: "https://docs.example/a?b=c#d" },
  );
});

it("resolves false when the system opener refuses", async () => {
  tauri.isTauri.mockReturnValue(true);
  tauri.invoke.mockRejectedValue(new Error("refused"));
  expect(await openInBrowser("https://docs.example/")).toBe(false);
});

it.each([
  "javascript:alert(1)",
  "file:///etc/passwd",
  "https://user:secret@docs.example/",
  "not a url",
])("refuses a URL the in-app browser refuses: %s", async (target) => {
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  expect(await openInBrowser(target)).toBe(false);
  tauri.isTauri.mockReturnValue(true);
  expect(await openInBrowser(target)).toBe(false);
  expect(opened).not.toHaveBeenCalled();
  expect(tauri.invoke).not.toHaveBeenCalled();
});
