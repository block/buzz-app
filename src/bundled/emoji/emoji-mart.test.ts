// @vitest-environment jsdom
import { SearchIndex } from "emoji-mart";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { mountEmojiMart } from "./emoji-mart";
import { PREVIEW_ACTION_SLOT } from "./add-emoji";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("adds fuzzy shortcode matches after Mart's own results", async () => {
  const martSearch = SearchIndex.search;
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
    const input = await vi.waitFor(() => {
      const element = root()?.querySelector<HTMLInputElement>("input");
      if (!element) throw new Error("Search has not rendered");
      return element;
    });
    const search = (query: string) => {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    for (const [query, expected] of [
      ["bufop", ":bufo-pray:"],
      ["bufopray", ":bufo-pray:"],
      [":bufop", ":bufo-pray:"],
      ["bufo_pray", ":bufo-pray:"],
      ["bfpray", ":bufo-pray:"],
      ["bufo p", ":bufo-pray:"],
      ["thumbsup", ":bufo-thumbs-up:"],
      ["pointup", "Index Pointing Up"],
      ["hearteyes", "Smiling Face with Heart-Eyes"],
      ["open_book", "Open Book"],
      ["thumbs up", "Thumbs Up"],
    ] as const) {
      // Clear first so the previous query's rendered results cannot pass this one.
      search("");
      await vi.waitFor(() => expect(results()).toEqual([]));
      search(query);
      await vi.waitFor(() => expect(results(), query).toContain(expected));
      // Mart's multi-word name match stays ahead of fuzzy fallbacks.
      if (query === "thumbs up") expect(results()[0]).toBe("Thumbs Up");
    }
  } finally {
    dispose();
  }
  expect(SearchIndex.search).toBe(martSearch);
});

it("previews the hovered emoji by name and shortcode instead of a title hint", async () => {
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
    preview: true,
    scope: "fixture",
    perLine: 8,
    emojiSize: 24,
    emojiButtonSize: 36,
    search: "",
    searchSelection: { current: undefined },
    searchChange() {},
    entries: [{ shortcode: "shipit", url: "https://a.test/shipit.png" }],
    media: (url) => url,
    select() {},
    close() {},
  });
  try {
    const root = () => host.querySelector("em-emoji-picker")?.shadowRoot;
    const preview = () => root()?.querySelector("#preview");
    const text = () =>
      [".preview-title", ".preview-subtitle", ".preview-placeholder"].map(
        (selector) => preview()?.querySelector(selector)?.textContent ?? null,
      );
    const input = await vi.waitFor(() => {
      const element = root()?.querySelector<HTMLInputElement>("input");
      if (!element || !preview()) throw new Error("Picker has not rendered");
      return element;
    });
    // Idle: no prompt and no stand-in emoji, but the row keeps its place.
    expect(text()).toEqual([null, null, ""]);
    expect(preview()?.querySelector(".emoji-mart-emoji")).toBeNull();
    expect(
      preview()?.querySelector(`slot[name="${PREVIEW_ACTION_SLOT}"]`),
    ).not.toBeNull();
    const search = (query: string) => {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    search("shipit");
    const custom = await vi.waitFor(() => {
      const button = root()?.querySelector<HTMLButtonElement>(
        '.category:not([data-id]) button[aria-posinset="1"]',
      );
      if (!button) throw new Error("Results have not rendered");
      return button;
    });
    expect(custom).not.toHaveAttribute("title");
    custom.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    custom.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() =>
      expect(text()).toEqual(["shipit", ":shipit:", null]),
    );
    expect(preview()?.querySelector("img")).toHaveAttribute(
      "src",
      "https://a.test/shipit.png",
    );
    search("zzzzqqqq");
    await vi.waitFor(() =>
      expect(text()).toEqual(["No emoji found", "", null]),
    );
    expect(preview()?.querySelector(".emoji-mart-emoji")).toBeNull();
  } finally {
    dispose();
  }
});
