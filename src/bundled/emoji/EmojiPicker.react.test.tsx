// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { createComposerShortcut } from "./composer-shortcut";
import { EmojiPicker } from "./EmojiPicker";

beforeEach(() => {
  for (const name of ["ResizeObserver", "IntersectionObserver"])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function harness(
  reactToLatest?: () => ((emoji: string) => boolean) | undefined,
) {
  const owner = createRelaySession(null);
  const shortcut = createComposerShortcut();
  const insert = vi.fn();
  const focus = vi.fn();
  render(
    <form>
      <input aria-label="Draft" />
      <EmojiPicker
        session={owner.session}
        scope="fixture"
        disabled={false}
        insert={insert}
        reactionShortcut={shortcut}
        reactToLatest={reactToLatest}
        focus={focus}
      />
    </form>,
  );
  return { owner, shortcut, insert, focus };
}

async function pickThumbsUp() {
  const root = await vi.waitFor(() => {
    const shadow = document.querySelector("em-emoji-picker")?.shadowRoot;
    if (!shadow) throw new Error("Mart has not rendered");
    return shadow;
  });
  const input = await vi.waitFor(() => {
    const element = root.querySelector<HTMLInputElement>("input");
    if (!element) throw new Error("Search has not rendered");
    return element;
  });
  input.value = "thumbs up";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const result = await vi.waitFor(() => {
    const button = root.querySelector<HTMLButtonElement>(
      ".category:not([data-id]) button[aria-posinset]",
    );
    if (button?.getAttribute("title") !== "Thumbs Up")
      throw new Error("Result has not rendered");
    return button;
  });
  act(() => result.click());
}

const reactPicker = () =>
  screen.queryByRole("dialog", { name: "React to latest message" });

it("routes a shortcut-opened selection to the captured target and returns focus", async () => {
  const commit = vi.fn(() => true);
  const reactToLatest = vi.fn(() => commit);
  const h = harness(reactToLatest);
  try {
    expect(h.shortcut.available()).toBe(true);
    act(() => h.shortcut.run());
    const popup = await screen.findByRole("dialog", {
      name: "React to latest message",
    });
    expect(reactToLatest).toHaveBeenCalledTimes(1);
    expect(within(popup).queryByRole("tab", { name: "GIF" })).toBeNull();
    await pickThumbsUp();
    expect(commit).toHaveBeenCalledWith("👍");
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.focus).toHaveBeenCalled();
    expect(reactPicker()).toBeNull();
  } finally {
    h.owner.dispose();
  }
});

it("escape returns to the composer; the trigger then opens insert mode again", async () => {
  const commit = vi.fn(() => true);
  const h = harness(() => commit);
  try {
    act(() => h.shortcut.run());
    const popup = await screen.findByRole("dialog", {
      name: "React to latest message",
    });
    fireEvent.keyDown(popup, { key: "Escape" });
    expect(h.focus).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(reactPicker()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Emoji and GIFS" }));
    await screen.findByRole("dialog", { name: "Emoji picker" });
    await pickThumbsUp();
    expect(h.insert).toHaveBeenCalledWith("👍");
    expect(commit).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
});

it("stays closed when there is no reaction target to capture", async () => {
  const reactToLatest = vi.fn(() => undefined);
  const h = harness(reactToLatest);
  try {
    expect(h.shortcut.available()).toBe(true);
    act(() => h.shortcut.run());
    expect(reactToLatest).toHaveBeenCalledTimes(1);
    expect(reactPicker()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    h.owner.dispose();
  }
});

it("keeps the picker open and reports when the toggle is rejected", async () => {
  const commit = vi.fn(() => false);
  const h = harness(() => commit);
  try {
    act(() => h.shortcut.run());
    const popup = await screen.findByRole("dialog", {
      name: "React to latest message",
    });
    await pickThumbsUp();
    expect(commit).toHaveBeenCalledWith("👍");
    expect(popup).toBeInTheDocument();
    // The offline catalog raises its own alert; find the reaction one.
    expect(
      within(popup)
        .getAllByRole("alert")
        .some((alert) =>
          alert.textContent?.includes("Could not update the reaction"),
        ),
    ).toBe(true);
    expect(h.focus).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
});

it("stays unavailable when the composer offers no reactToLatest command", () => {
  const h = harness();
  try {
    expect(h.shortcut.available()).toBe(false);
  } finally {
    h.owner.dispose();
  }
});
