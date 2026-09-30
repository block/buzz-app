// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { ReactionAnimation } from "../../features/messages/ReactionAnimation";
import { AnimatedEmoji, animatedEmojiMatches } from "./AnimatedEmoji";
import { notoAsset } from "./noto-playback";

let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["animation"]),
    })),
  );
  URL.createObjectURL = vi.fn(() => "blob:noto-test");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("preserves unsupported whole sequences and explicit text presentation", () => {
  const text = "Hi 👍🏽 ❤️‍🔥 👍 ❤️ 😂 ©︎!";
  for (const { start, end } of animatedEmojiMatches(text)) {
    expect(["👍🏽", "❤️‍🔥", "👍", "❤️", "😂"]).toContain(text.slice(start, end));
  }
  expect(notoAsset("©︎")).toBeUndefined();
  expect(notoAsset("❤️")?.code).toBe("2764_fe0f");
});
it("is still until hover, plays once, then restores its still and releases the URL", async () => {
  render(<AnimatedEmoji text="😂" />);
  const image = screen.getByRole("img", { name: "😂" });
  expect(image.getAttribute("data-copy-emoji")).toBe("😂");
  expect(image.getAttribute("src")).toBe("/emoji/noto-animated/1f602.svg");
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.pointerEnter(image);
  });
  expect(image.getAttribute("src")).toBe("blob:noto-test");
  fireEvent.load(image);
  act(() => vi.advanceTimersByTime(notoAsset("😂")?.duration ?? 0));
  expect(image.getAttribute("src")).toContain("1f602.svg");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:noto-test");
});
it("does not load animation under reduced motion and falls back on a broken still", () => {
  reduced = true;
  const { container } = render(<AnimatedEmoji text="🔥" />);
  const image = screen.getByRole("img", { name: "🔥" });
  fireEvent.pointerEnter(image);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.error(image);
  expect(container.textContent).toBe("🔥");
});
it("releases an active animation on unmount", async () => {
  const { unmount } = render(<AnimatedEmoji text="🚀" />);
  await act(async () => {
    fireEvent.pointerEnter(screen.getByRole("img"));
  });
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:noto-test");
});

it("starts reaction scaling with playback and lets it finish after the add signal clears", async () => {
  const start = vi.fn();
  const view = render(
    <ReactionAnimation.Provider value={{ celebrate: true, start }}>
      <AnimatedEmoji text="😀" />
    </ReactionAnimation.Provider>,
  );
  await act(async () => {});
  const image = screen.getByRole("img");
  expect(start).not.toHaveBeenCalled();
  fireEvent.load(image);
  expect(start).toHaveBeenCalledExactlyOnceWith(2100);
  view.rerender(
    <ReactionAnimation.Provider value={{ celebrate: false, start }}>
      <AnimatedEmoji text="😀" />
    </ReactionAnimation.Provider>,
  );
  act(() => vi.advanceTimersByTime(2099));
  expect(image.getAttribute("src")).toBe("blob:noto-test");
  act(() => vi.advanceTimersByTime(1));
  expect(image.getAttribute("src")).toContain("1f600.svg");
});

it("plays each composer insertion once without restarting on rerender", async () => {
  const content = {
    text: "🔥",
    message: {
      id: "composer",
      authorId: "",
      createdAt: 0,
      channelId: "c",
      content: "🔥",
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    },
  };
  const view = render(
    <StrictMode>
      <AnimatedEmoji text="🔥" content={content} />
    </StrictMode>,
  );
  await act(async () => {});
  const image = screen.getByRole("img");
  expect(image.getAttribute("src")).toBe("blob:noto-test");
  fireEvent.load(image);
  act(() => vi.advanceTimersByTime(notoAsset("🔥")?.duration ?? 0));
  expect(image.getAttribute("src")).toContain("1f525.svg");
  view.rerender(
    <StrictMode>
      <AnimatedEmoji text="🔥" content={{ ...content }} />
    </StrictMode>,
  );
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});

it("plays once when entering the completion row, including its label", async () => {
  render(
    <div role="listbox">
      <div role="option" aria-selected="false" tabIndex={-1}>
        <AnimatedEmoji text="😂" hoverOption />
        <span>:joy:</span>
      </div>
    </div>,
  );
  const option = screen.getByRole("option");
  const image = screen.getByRole("img");
  expect(image.getAttribute("src")).toContain("1f602.svg");
  await act(async () => {
    fireEvent.pointerEnter(option);
  });
  expect(image.getAttribute("src")).toBe("blob:noto-test");
  fireEvent.load(image);
  act(() => vi.advanceTimersByTime(notoAsset("😂")?.duration ?? 0));
  expect(image.getAttribute("src")).toContain("1f602.svg");
  await act(async () => {
    fireEvent.pointerEnter(image);
  });
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  fireEvent.pointerLeave(option);
  await act(async () => {
    fireEvent.pointerEnter(option);
  });
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
});

it("plays a suggested reaction when hovering its button padding", async () => {
  const content = {
    text: "👍",
    message: {
      id: "existing",
      authorId: "",
      createdAt: 0,
      channelId: "c",
      content: "Hi",
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    },
    reaction: { content: "👍", events: [] },
  };
  render(
    <button type="button" aria-label="React with thumbs up">
      <AnimatedEmoji text="👍" content={content} />
    </button>,
  );
  const image = screen.getByRole("img");
  expect(image.getAttribute("src")).toContain("1f44d.svg");
  await act(async () => {
    fireEvent.pointerEnter(screen.getByRole("button"));
  });
  expect(image.getAttribute("src")).toBe("blob:noto-test");
  fireEvent.load(image);
  act(() => vi.advanceTimersByTime(notoAsset("👍")?.duration ?? 0));
  expect(image.getAttribute("src")).toContain("1f44d.svg");
});

it("plays a new message under StrictMode and does not replay after remount", async () => {
  const content = {
    text: "🎉",
    message: {
      id: "new-message-strict",
      authorId: "",
      createdAt: Date.now() / 1000,
      channelId: "c",
      content: "🎉",
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    },
  };
  const view = render(
    <StrictMode>
      <AnimatedEmoji text="🎉" content={content} />
    </StrictMode>,
  );
  await act(async () => {});
  const image = screen.getByRole("img");
  expect(image.getAttribute("src")).toBe("blob:noto-test");
  fireEvent.load(image);
  view.unmount();
  render(<AnimatedEmoji text="🎉" content={content} />);
  await act(async () => {});
  expect(screen.getByRole("img").getAttribute("src")).toContain("1f389.svg");
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});
