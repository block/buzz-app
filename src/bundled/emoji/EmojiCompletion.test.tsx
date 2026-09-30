// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CompletionResult } from "../../features/conversation/contracts";
import { createRelaySession } from "../../features/relay/session";
import { keypair } from "../../features/relay/testing";
import { EmojiCompletion } from "./EmojiCompletion";
import { searchEmoji } from "./emoji-search";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("bounds broad-query previews and defers native alignment until visible", async () => {
  const visible: (() => void)[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        visible.push(() => callback([{ isIntersecting: true }]));
      }
      observe() {}
      disconnect() {}
    },
  );
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    query: async () => [],
  });
  try {
    const expected = await searchEmoji("he", []);
    expect(expected.length).toBeGreaterThan(50);
    let result: CompletionResult | undefined;
    await act(async () => {
      render(
        <EmojiCompletion
          session={owner.session}
          scope="fixture"
          channelId="c"
          observation={{ revision: 1, text: ":he", start: 3, end: 3 }}
          query={{ query: "he", start: 0, end: 3 }}
          publish={(next) => {
            result = next;
            return () => {};
          }}
        />,
      );
    });
    expect(result?.items.map((item) => item.id)).toEqual(
      expected.slice(0, 50).map((item) => item.id),
    );
    render(
      <div role="listbox">
        {result?.items.map((item) => (
          <div key={item.id}>{item.preview}</div>
        ))}
      </div>,
    );
    expect(visible.length).toBeGreaterThan(0);
    expect(bounds).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
    act(() => visible[0]?.());
    expect(canvas).toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});
