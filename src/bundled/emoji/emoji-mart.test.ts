// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountEmojiMart } from "./emoji-mart";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("finds custom emoji by run-together words from any word start", async () => {
  for (const name of ["ResizeObserver", "IntersectionObserver"])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  const host = document.body.appendChild(document.createElement("div"));
  const dispose = mountEmojiMart({
    host,
    autoFocus: false,
    scope: "fixture",
    perLine: 8,
    emojiSize: 24,
    emojiButtonSize: 36,
    search: "",
    searchSelection: { current: undefined },
    searchChange() {},
    entries: ["bufo-pray", "bufo-thumbs-up"].map((shortcode) => ({
      shortcode,
      url: `https://a.test/${shortcode}.png`,
    })),
    media: (url) => url,
    select() {},
    close() {},
  });
  try {
    const root = () => host.querySelector("em-emoji-picker")?.shadowRoot;
    const results = () =>
      [
        ...(root()?.querySelectorAll(
          ".category:not([data-id]) button[aria-posinset]",
        ) ?? []),
      ].map((button) => button.getAttribute("title"));
    for (const [query, expected] of [
      ["bufop", ":bufo-pray:"],
      ["bufopray", ":bufo-pray:"],
      [":bufop", ":bufo-pray:"],
      ["bufo p", ":bufo-pray:"],
      ["thumbsup", ":bufo-thumbs-up:"],
    ] as const) {
      await vi.waitFor(() => {
        const input = root()?.querySelector<HTMLInputElement>("input");
        if (!input) throw new Error("Search has not rendered");
        if (input.value !== query) {
          input.value = query;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        expect(results()).toContain(expected);
      });
      // Joins start at word boundaries; `thumbsup` must not match `bufo-pray`.
      if (query === "thumbsup") expect(results()).not.toContain(":bufo-pray:");
    }
  } finally {
    dispose();
  }
});
