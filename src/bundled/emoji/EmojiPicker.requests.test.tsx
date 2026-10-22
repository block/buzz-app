// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { relayGifRequests } from "../../features/relay/gifs";
import { EmojiPicker } from "./EmojiPicker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses the supplied window owner for GIF discovery, search, retry and selection", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const direct = vi
    .spyOn(relayGifRequests, "supports")
    .mockRejectedValue(new Error("Native ACL denies child relay access"));
  const directSearch = vi.spyOn(relayGifRequests, "search");
  const asset = {
    url: "https://example.test/hello.gif",
    width: 100,
    height: 100,
    size: 20,
  };
  const supports = vi.fn(async () => true);
  const search = vi
    .fn()
    .mockRejectedValueOnce(new Error("Search offline"))
    .mockResolvedValue([
      { id: 1, slug: "hello", title: "Hello", preview: asset, original: asset },
    ]);
  const insert = vi.fn();
  const owner = createRelaySession(null);
  try {
    render(
      <EmojiPicker
        session={owner.session}
        scope={`https://example.test:${"ab".repeat(32)}`}
        disabled={false}
        insert={insert}
        gifRequests={{ supports, search }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Emoji and GIFS" }));
    fireEvent.click(await screen.findByRole("tab", { name: "GIF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search offline",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose Hello" }),
    );
    expect(supports).toHaveBeenCalledWith(
      "https://example.test",
      expect.any(AbortSignal),
    );
    expect(search).toHaveBeenCalledWith(
      "https://example.test",
      "",
      expect.any(AbortSignal),
    );
    expect(search).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledWith(
      "![Hello](https://example.test/hello.gif)",
    );
    expect(direct).not.toHaveBeenCalled();
    expect(directSearch).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it.each(["metaKey", "ctrlKey"])(
  "opens GIF search from the owning composer with %s+G",
  async (modifier) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const owner = createRelaySession(null);
    let resolveSupport!: (supported: boolean) => void;
    const supports = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSupport = resolve;
        }),
    );
    const search = vi.fn(async () => []);
    try {
      render(
        <form>
          <input aria-label="Draft" />
          <EmojiPicker
            session={owner.session}
            scope={`https://example.test:${"ab".repeat(32)}`}
            disabled={false}
            insert={vi.fn()}
            gifRequests={{ supports, search }}
          />
        </form>,
      );
      const draft = screen.getByRole("textbox", { name: "Draft" });
      draft.focus();
      fireEvent.keyDown(draft, { key: "g", [modifier]: true });
      expect(
        await screen.findByRole("searchbox", { name: "Search GIFs" }),
      ).toHaveFocus();
      expect(search).not.toHaveBeenCalled();
      resolveSupport(true);
      expect(screen.getByRole("tab", { name: "GIF" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      owner.dispose();
    }
  },
);
