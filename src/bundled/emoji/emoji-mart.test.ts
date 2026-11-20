// @vitest-environment jsdom
import { SearchIndex } from "emoji-mart";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { mountEmojiMart } from "./emoji-mart";
import { PREVIEW_ACTION_SLOT } from "./add-emoji";
import { SKIN_TONE_SLOT } from "./skin-tone";
import * as skinTone from "./skin-tone";
import { emojiUsage } from "./emoji-usage";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each([true, false])(
  "handles first skin-tone acceptance (%s) and learns the base id",
  async (accepted) => {
    vi.spyOn(skinTone, "skinToneUnchosen").mockReturnValue(true);
    vi.spyOn(skinTone, "rememberSkinTone").mockImplementation(() => {});
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
    const select = vi.fn(() => accepted);
    const scope = `tone-${accepted}`;
    const dispose = mountEmojiMart({
      host,
      autoFocus: false,
      preview: true,
      remember: true,
      scope,
      perLine: 8,
      emojiSize: 24,
      emojiButtonSize: 36,
      search: "",
      searchSelection: { current: undefined },
      searchChange() {},
      entries: [],
      media: (url) => url,
      select,
      close() {},
    });
    try {
      const picker = host.querySelector("em-emoji-picker");
      const footer = document.createElement("div");
      footer.slot = SKIN_TONE_SLOT;
      const trigger = footer.appendChild(document.createElement("button"));
      trigger.textContent = "Choose default skin tone";
      picker?.append(footer);
      const input = await vi.waitFor(() => {
        const input = picker?.shadowRoot?.querySelector("input");
        if (!input) throw new Error("Picker loading");
        return input;
      });
      input.value = "thumbs up";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const thumb = await vi.waitFor(() => {
        const button = picker?.shadowRoot?.querySelector<HTMLButtonElement>(
          '.category:not([data-id]) button[aria-posinset="1"]',
        );
        if (!button) throw new Error("Thumbs-up search result loading");
        return button;
      });
      expect(thumb).toHaveAttribute("aria-label", "👍");
      thumb.click();
      const radio = await vi.waitFor(() => {
        const radio = picker?.shadowRoot?.querySelector<HTMLInputElement>(
          '.menu input[value="4"]',
        );
        if (!radio) throw new Error("Tone menu loading");
        return radio;
      });
      radio.focus();
      (radio.nextElementSibling as HTMLElement).click();
      await vi.waitFor(() =>
        expect(select).toHaveBeenCalledWith("👍🏽", undefined),
      );
      expect([...emojiUsage(scope)]).toEqual(
        accepted ? [["unicode/+1", 1]] : [],
      );
      if (!accepted) await vi.waitFor(() => expect(trigger).toHaveFocus());
    } finally {
      dispose();
    }
  },
);

it.each([
  { accepted: true, remember: true },
  { accepted: false, remember: true },
  { accepted: true, remember: false },
  { accepted: true, remember: undefined },
])(
  "records accepted picker choices only with opt-in ($accepted, $remember)",
  async ({ accepted, remember }) => {
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
    const scope =
      remember === undefined ? "avatar" : `usage-${accepted}-${remember}`;
    const select = vi.fn(() => accepted);
    const dispose = mountEmojiMart({
      host,
      autoFocus: false,
      ...(remember === undefined ? {} : { remember }),
      scope,
      perLine: 8,
      emojiSize: 24,
      emojiButtonSize: 36,
      search: "",
      searchSelection: { current: undefined },
      searchChange() {},
      entries: [{ shortcode: "job", url: "https://a.test/job.png" }],
      media: (url) => url,
      select,
      close() {},
    });
    try {
      const input = await vi.waitFor(() => {
        const input = host
          .querySelector("em-emoji-picker")
          ?.shadowRoot?.querySelector("input");
        if (!input) throw new Error("Picker loading");
        return input;
      });
      for (const [query, title, id] of [
        ["joy", "Face with Tears of Joy", "unicode/joy"],
        ["job", ":job:", "custom/job"],
      ] as const) {
        input.value = query;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const button = await vi.waitFor(() => {
          const button = host
            .querySelector("em-emoji-picker")
            ?.shadowRoot?.querySelector<HTMLButtonElement>(
              `button[title="${title}"]`,
            );
          if (!button) throw new Error("Search loading");
          return button;
        });
        expect(emojiUsage(scope).get(id)).toBeUndefined();
        button.click();
        expect(emojiUsage(scope).get(id)).toBe(
          accepted && remember ? 1 : undefined,
        );
      }
      expect(select).toHaveBeenCalledTimes(2);
      if (!remember)
        expect(
          localStorage.getItem(
            `buzz-view.v1:${JSON.stringify([scope, "emoji:usage:v1"])}`,
          ),
        ).toBeNull();
      // Preserve native insertion even when Mart supplies no usage identity.
      const before = [...emojiUsage(scope)];
      const picker = host.querySelector("em-emoji-picker") as HTMLElement & {
        props: { onEmojiSelect(emoji: { native: string }): void };
      };
      picker.props.onEmojiSelect({ native: "😂" });
      expect(select).toHaveBeenCalledTimes(3);
      expect(select).toHaveBeenLastCalledWith("😂", undefined);
      expect([...emojiUsage(scope)]).toEqual(before);
    } finally {
      dispose();
    }
  },
);

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
  const skinToneChange = vi.fn();
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
    skinToneChange,
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
    // The footer, not the category bar, offers the saved default tone.
    expect(
      preview()?.querySelector(`slot[name="${SKIN_TONE_SLOT}"]`),
    ).not.toBeNull();
    expect(root()?.querySelector("#nav .skin-tone")).toBeNull();
    expect(skinToneChange).toHaveBeenLastCalledWith(1, false);
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
    // The preview takes Add emoji's place only while an emoji is shown.
    expect(preview()).toHaveAttribute("data-buzz-previewing");
    search("zzzzqqqq");
    await vi.waitFor(() => expect(text()).toEqual(["", "", null]));
    await vi.waitFor(() =>
      expect(preview()).not.toHaveAttribute("data-buzz-previewing"),
    );
    expect(preview()?.querySelector(".emoji-mart-emoji")).toBeNull();
  } finally {
    dispose();
  }
});
