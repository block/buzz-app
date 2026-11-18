// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatAvatar } from "./use-chat-avatar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["webp", "gif", "png"])(
  "keeps the cached portrait while idle, plays %s during a response, and follows motion changes",
  (extension) => {
    const url = `https://community.test/media/${"a".repeat(64)}.${extension}`;
    const media = (source: string, size?: "small") =>
      size ? "cached-thumb" : `protected:${source}`;
    let motion = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return motion;
      },
      addEventListener: (_event: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_event: string, fn: () => void) =>
        listeners.delete(fn),
    }));
    const loads: Array<{ onload?: (() => void) | null }> = [];
    vi.stubGlobal(
      "Image",
      class {
        onload = null;
        constructor() {
          loads.push(this);
        }
      },
    );
    const { result, rerender, unmount } = renderHook(
      ({ value, responding }) => useChatAvatar(value, media, responding),
      { initialProps: { value: url, responding: false } },
    );
    expect(loads).toHaveLength(0);
    rerender({ value: url, responding: true });
    expect(result.current).toBe("cached-thumb");
    act(() => loads[0]?.onload?.());
    expect(result.current).toBe(`protected:${url}`);
    rerender({ value: url, responding: false });
    expect(result.current).toBe("cached-thumb");
    rerender({ value: url, responding: true });
    act(() => loads.at(-1)?.onload?.());
    expect(result.current).toBe(`protected:${url}`);
    act(() => {
      motion = false;
      for (const fn of listeners) fn();
    });
    expect(result.current).toBe("cached-thumb");
    rerender({ value: url.replace(/\.[^.]+$/, ".jpg"), responding: true });
    expect(loads).toHaveLength(2);
    unmount();
    expect(listeners.size).toBe(0);
  },
);

it("keeps the still while loading and retires pending images when the source changes or unmounts", () => {
  const url = `https://community.test/media/${"a".repeat(64)}.webp`;
  const other = url.replace("a".repeat(64), "b".repeat(64));
  const media = (source: string, size?: "small") =>
    (size ? "thumb:" : "protected:") + source;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const loads: Array<{ onload: (() => void) | null }> = [];
  vi.stubGlobal(
    "Image",
    class {
      onload = null;
      constructor() {
        loads.push(this);
      }
    },
  );
  const { result, rerender, unmount } = renderHook(
    ({ source }) => useChatAvatar(source, media, true),
    { initialProps: { source: url } },
  );
  expect(result.current).toBe(`thumb:${url}`);
  rerender({ source: other });
  expect(loads[0]?.onload).toBeNull();
  expect(result.current).toBe(`thumb:${other}`);
  act(() => loads[1]?.onload?.());
  expect(result.current).toBe(`protected:${other}`);
  unmount();
  expect(loads[1]?.onload).toBeNull();
});

it("never preloads an original that the community resolver does not protect", () => {
  const url = `https://other.test/media/${"a".repeat(64)}.webp`;
  const image = vi.fn();
  vi.stubGlobal("Image", image);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const media = (source: string) => source;
  const { result } = renderHook(() => useChatAvatar(url, media, true));
  expect(result.current).toBe(url);
  expect(image).not.toHaveBeenCalled();
});

it("uses the protected legacy animation and keeps the poster for unsupported fragments", () => {
  const origin = "https://community.test";
  const poster = `${origin}/media/${"1".repeat(64)}.png`;
  const loop = `${origin}/media/${"2".repeat(64)}.png`;
  const media = vi.fn((src: string, size?: "small") =>
    size ? "thumb" : `protected:${src}`,
  );
  let complete: (() => void) | undefined;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "Image",
    class {
      set onload(fn: () => void) {
        complete = fn;
      }
    },
  );
  const { result, rerender } = renderHook(
    ({ fragment }) => useChatAvatar(poster + fragment, media, true),
    { initialProps: { fragment: `#buzz-anim=${encodeURIComponent(loop)}` } },
  );
  expect(result.current).toBe("thumb");
  act(() => complete?.());
  expect(result.current).toBe(`protected:${loop}`);
  for (const fragment of [
    "#buzz-anim=%",
    "#buzz-anim=" +
      encodeURIComponent(loop.replace(origin, "https://other.test")),
    "#unknown",
  ]) {
    media.mockClear();
    rerender({ fragment });
    expect(result.current).toBe("thumb");
    expect(media.mock.calls.every((args) => args[1] === "small")).toBe(true);
  }
});
