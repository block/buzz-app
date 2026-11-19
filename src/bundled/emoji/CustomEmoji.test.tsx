// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CustomEmoji } from "./CustomEmoji";

const emoji = { shortcode: "party", url: "https://emoji.test/party.png" };
const media = (url: string) => url;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("recovers a transient image failure without remounting the message", () => {
  vi.useFakeTimers();
  const view = render(<CustomEmoji emoji={emoji} media={media} />);
  fireEvent.error(view.getByRole("img"));
  expect(view.container).toHaveTextContent(":party:");
  act(() => vi.advanceTimersByTime(2_000));
  expect(view.getByRole("img")).toHaveAttribute("src", emoji.url);
  fireEvent.load(view.getByRole("img"));
  expect(view.container).not.toHaveTextContent(":party:");
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds retries and cancels pending recovery when unmounted", () => {
  vi.useFakeTimers();
  const view = render(<CustomEmoji emoji={emoji} media={media} />);
  for (const delay of [2_000, 10_000, 30_000]) {
    fireEvent.error(view.getByRole("img"));
    act(() => vi.advanceTimersByTime(delay - 1));
    expect(view.queryByRole("img")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(view.getByRole("img")).toHaveAttribute("src", emoji.url);
  }
  fireEvent.error(view.getByRole("img"));
  expect(view.container).toHaveTextContent(":party:");
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  const pending = render(<CustomEmoji emoji={emoji} media={media} />);
  fireEvent.error(pending.getByRole("img"));
  pending.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("gives a changed source its own retry budget and never requests denied media", () => {
  vi.useFakeTimers();
  const view = render(<CustomEmoji emoji={emoji} media={media} />);
  fireEvent.error(view.getByRole("img"));
  const next = { ...emoji, url: "https://emoji.test/new.png" };
  view.rerender(<CustomEmoji emoji={next} media={media} />);
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.error(view.getByRole("img"));
  act(() => vi.advanceTimersByTime(2_000));
  expect(view.getByRole("img")).toHaveAttribute("src", next.url);
  view.rerender(<CustomEmoji emoji={next} media={() => undefined} />);
  expect(view.queryByRole("img")).toBeNull();
  expect(view.container).toHaveTextContent(":party:");
  expect(vi.getTimerCount()).toBe(0);
});

it("paints a remounted emoji in its first frame", () => {
  const remounted = { ...emoji, url: "https://emoji.test/remount.png" };
  const first = render(<CustomEmoji emoji={remounted} media={media} />);
  expect(first.getByRole("img")).toHaveAttribute("loading", "lazy");
  fireEvent.load(first.getByRole("img"));
  first.unmount();
  // WebKit re-requests a lazy custom-scheme image per element and paints a
  // ready async-decoded one as empty for a frame.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    22,
  );
  const second = render(<CustomEmoji emoji={remounted} media={media} />);
  expect(second.getByRole("img")).toHaveAttribute("loading", "eager");
  expect(second.getByRole("img")).toHaveAttribute("decoding", "sync");
});
