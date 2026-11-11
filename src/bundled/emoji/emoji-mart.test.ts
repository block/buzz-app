// @vitest-environment jsdom
import { SearchIndex } from "emoji-mart";
import { afterEach, expect, it, vi } from "vitest";
import { mountEmojiMart } from "./emoji-mart";

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
    favorites: [],
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

it("groups favorited palette emoji into a Favorites category before Custom", async () => {
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
  const entries = ["bufo-pray", "bufo-thumbs-up"].map((shortcode) => ({
    shortcode,
    url: `https://a.test/${shortcode}.png`,
  }));
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
    entries,
    favorites: ["bufo-thumbs-up", "gone", "bufo-pray"],
    media: (url) => url,
    select() {},
    close() {},
  });
  try {
    const root = () => host.querySelector("em-emoji-picker")?.shadowRoot;
    await vi.waitFor(() =>
      expect(
        root()?.querySelector('#nav button[aria-label="Favorites"]'),
      ).toBeTruthy(),
    );
    const martRoot = () => {
      const shadow = root();
      if (!shadow) throw new Error("Mart has not mounted");
      return shadow;
    };
    // A favorite that left the palette is skipped, not shown empty.
    const labels = [...martRoot().querySelectorAll("#nav button")].map(
      (button) => button.getAttribute("aria-label"),
    );
    expect(labels).toContain("Favorites");
    expect(labels).toContain("Custom");
    expect(labels.indexOf("Favorites")).toBeLessThan(labels.indexOf("Custom"));
    const favoritesCategory = martRoot().querySelector(
      '.category[data-id="buzz-favorites"]',
    );
    // Custom stays addressable as its own category even alongside Favorites.
    const customCategory = martRoot().querySelector(
      '.category[data-id="buzz-custom"]',
    );
    expect(favoritesCategory).toBeTruthy();
    expect(customCategory).toBeTruthy();
    if (!favoritesCategory || !customCategory) return;
    expect(
      [...favoritesCategory.querySelectorAll("img")].map((img) => img.src),
    ).toEqual([
      "https://a.test/bufo-thumbs-up.png",
      "https://a.test/bufo-pray.png",
    ]);
    expect(
      martRoot().querySelectorAll('.category[data-id="buzz-favorites"]'),
    ).toHaveLength(1);
  } finally {
    dispose();
  }
  // A remount without favorites still shows the palette: the remount
  // registration path must not drop custom categories when none are favorited.
  const remounted = mountEmojiMart({
    host,
    autoFocus: false,
    scope: "fixture",
    perLine: 8,
    emojiSize: 24,
    emojiButtonSize: 36,
    search: "",
    searchSelection: { current: undefined },
    searchChange() {},
    entries,
    favorites: [],
    media: (url) => url,
    select() {},
    close() {},
  });
  try {
    const root = () => host.querySelector("em-emoji-picker")?.shadowRoot;
    await vi.waitFor(() =>
      expect(
        root()?.querySelector('#nav button[aria-label="Custom"]'),
      ).toBeTruthy(),
    );
    expect(
      root()?.querySelector('#nav button[aria-label="Favorites"]'),
    ).toBeNull();
  } finally {
    remounted();
  }
});
