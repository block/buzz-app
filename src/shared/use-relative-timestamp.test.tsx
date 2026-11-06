// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRelativeTimestamp } from "./use-relative-timestamp";

const now = new Date(2026, 8, 24, 12).getTime() / 1000;
// Memoized like timeline rows: nothing above re-renders them.
const Label = memo(function Label({ at }: { at: number | undefined }) {
  return <p>{useRelativeTimestamp(at) ?? "none"}</p>;
});
const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("p")].map((label) => label.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("relabels mounted callers from one timer that stops with the last of them", () => {
  const callers = (more: number[] = []) => (
    <>
      <Label at={now - 30} />
      <Label at={now - 3600} />
      <Label at={undefined} />
      {more.map((at) => (
        <Label key={at} at={at} />
      ))}
    </>
  );
  const { container, rerender, unmount } = render(callers());
  expect(labels(container)).toEqual(["just now", "1 hour ago", "none"]);
  expect(vi.getTimerCount()).toBe(1);
  // A label mounted between ticks reads the same clock as those showing.
  vi.setSystemTime((now + 45) * 1000);
  rerender(callers([now - 30]));
  expect(labels(container)).toEqual([
    "just now",
    "1 hour ago",
    "none",
    "just now",
  ]);
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(30_000));
  expect(labels(container)).toEqual([
    "1 minute ago",
    "1 hour ago",
    "none",
    "1 minute ago",
  ]);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("arms nothing for callers without a time", () => {
  render(<Label at={undefined} />);
  expect(vi.getTimerCount()).toBe(0);
});
