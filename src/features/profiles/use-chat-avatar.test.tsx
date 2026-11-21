// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useChatAvatar } from "./use-chat-avatar";
import { stubAvatarAnimationFetch } from "./avatar-animation-testing";

const url = `https://community.test/media/${"a".repeat(64)}.webp`;
const media = (source: string, size?: "small") =>
  size ? `thumb:${source}` : `protected:${source}`;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture() {
  const network = stubAvatarAnimationFetch();
  let motion = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return motion;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  const loads: Array<{
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  }> = [];
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = null;
      onerror = null;
      constructor() {
        loads.push(this);
      }
    },
  );
  return {
    ...network,
    loads,
    listeners,
    motion(value: boolean) {
      act(() => {
        motion = value;
        for (const fn of listeners) fn();
      });
    },
  };
}

it("does not reuse a loaded animation when motion is disabled while idle", async () => {
  const f = fixture();
  const commits: Array<string | undefined> = [];
  function Portrait({ responding }: { responding: boolean }) {
    const src = useChatAvatar(url, media, responding);
    useLayoutEffect(() => {
      commits.push(src);
    });
    return null;
  }
  const view = render(<Portrait responding />);
  await waitFor(() => expect(f.loads).toHaveLength(1));
  act(() => f.loads[0]?.onload?.());
  expect(commits.at(-1)).toBe("blob:avatar-1");
  view.rerender(<Portrait responding={false} />);
  f.motion(false);
  commits.length = 0;
  view.rerender(<Portrait responding />);
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every((src) => src === `thumb:${url}`)).toBe(true);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it.each(["webp", "gif", "png"])(
  "loads protected %s bytes only while active and retires playback on motion change",
  async (extension) => {
    const f = fixture();
    const source = url.replace(/webp$/, extension);
    const { result, rerender, unmount } = renderHook(
      ({ active }) => useChatAvatar(source, media, active),
      { initialProps: { active: false } },
    );
    expect(f.fetch).not.toHaveBeenCalled();
    rerender({ active: true });
    expect(result.current).toBe(`thumb:${source}`);
    await waitFor(() => expect(f.loads).toHaveLength(1));
    expect(f.fetch).toHaveBeenCalledWith(`protected:${source}`, {
      signal: expect.any(AbortSignal),
    });
    expect(f.loads[0]?.src).toBe("blob:avatar-1");
    act(() => f.loads[0]?.onload?.());
    expect(result.current).toBe("blob:avatar-1");
    rerender({ active: false });
    expect(result.current).toBe(`thumb:${source}`);
    expect(f.loads[0]?.src).toBe("");
    expect(f.loads[0]?.onload).toBeNull();
    expect(f.revoke).toHaveBeenCalledWith("blob:avatar-1");
    rerender({ active: true });
    await waitFor(() => expect(f.loads).toHaveLength(2));
    act(() => f.loads[1]?.onload?.());
    expect(result.current).toBe("blob:avatar-2");
    f.motion(false);
    expect(result.current).toBe(`thumb:${source}`);
    expect(f.loads[1]?.src).toBe("");
    expect(f.revoke).toHaveBeenCalledWith("blob:avatar-2");
    unmount();
    expect(f.listeners.size).toBe(0);
  },
);

it("retires pending images on source changes and ignores stale load callbacks", async () => {
  const f = fixture();
  const other = url.replace("a".repeat(64), "b".repeat(64));
  const { result, rerender, unmount } = renderHook(
    ({ source }) => useChatAvatar(source, media, true),
    { initialProps: { source: url } },
  );
  await waitFor(() => expect(f.loads).toHaveLength(1));
  const stale = f.loads[0]?.onload;
  rerender({ source: other });
  expect(f.loads[0]?.src).toBe("");
  expect(f.loads[0]?.onload).toBeNull();
  act(() => stale?.());
  expect(result.current).toBe(`thumb:${other}`);
  await waitFor(() => expect(f.loads).toHaveLength(2));
  act(() => f.loads[1]?.onload?.());
  expect(result.current).toBe("blob:avatar-2");
  unmount();
  expect(f.loads[1]?.src).toBe("");
  expect(f.revoke).toHaveBeenCalledTimes(2);
});

it.each(["idle", "motion", "unmount"])(
  "aborts pending fetch on %s and never decodes its late result",
  async (stop) => {
    const f = fixture();
    const response = await f.fetch("/fixture");
    f.fetch.mockClear();
    let release!: (r: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result, rerender, unmount } = renderHook(
      ({ active }) => useChatAvatar(url, media, active),
      { initialProps: { active: true } },
    );
    expect(f.fetch).toHaveBeenCalledOnce();
    const signal = f.fetch.mock.calls[0]?.[1]?.signal;
    if (stop === "idle") rerender({ active: false });
    else if (stop === "motion") f.motion(false);
    else unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      release(response);
    });
    expect(f.loads).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();
    expect(result.current).toBe(`thumb:${url}`);
  },
);

it("never downloads originals that the community resolver does not protect", () => {
  const f = fixture();
  const { result } = renderHook(() =>
    useChatAvatar(url, (source) => source, true),
  );
  expect(result.current).toBe(url);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("uses the protected legacy animation and rejects unsupported fragments", async () => {
  const f = fixture();
  const poster = url.replace("webp", "png");
  const loop = poster.replace("a".repeat(64), "b".repeat(64));
  const { result, rerender } = renderHook(
    ({ fragment }) => useChatAvatar(poster + fragment, media, true),
    { initialProps: { fragment: `#buzz-anim=${encodeURIComponent(loop)}` } },
  );
  await waitFor(() => expect(f.loads).toHaveLength(1));
  expect(f.fetch.mock.calls[0]?.[0]).toBe(`protected:${loop}`);
  act(() => f.loads[0]?.onload?.());
  expect(result.current).toBe("blob:avatar-1");
  for (const fragment of [
    "#buzz-anim=%",
    `#buzz-anim=${encodeURIComponent(loop.replace("community.test", "other.test"))}`,
    "#unknown",
  ]) {
    rerender({ fragment });
    expect(result.current).toBe(`thumb:${poster + fragment}`);
    expect(f.fetch).toHaveBeenCalledOnce();
  }
});

it("keeps the still for rejected bytes and releases an image that fails to decode", async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response("not an image"));
  const { result, rerender } = renderHook(
    ({ source }) => useChatAvatar(source, media, true),
    { initialProps: { source: url } },
  );
  await act(async () => {});
  expect(f.loads).toHaveLength(0);
  expect(result.current).toBe(`thumb:${url}`);
  const other = url.replace("a".repeat(64), "b".repeat(64));
  rerender({ source: other });
  await waitFor(() => expect(f.loads).toHaveLength(1));
  act(() => f.loads[0]?.onerror?.());
  expect(result.current).toBe(`thumb:${other}`);
  expect(f.loads[0]?.src).toBe("");
  expect(f.revoke).toHaveBeenCalledWith("blob:avatar-1");
});
