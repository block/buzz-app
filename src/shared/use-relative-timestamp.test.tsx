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
  vi.restoreAllMocks();
});

it("relabels mounted callers from one interval that stops with the last of them", () => {
  const interval = vi.spyOn(globalThis, "setInterval");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const { container, unmount } = render(
    <>
      <Label at={now - 30} />
      <Label at={now - 3600} />
      <Label at={undefined} />
    </>,
  );
  expect(labels(container)).toEqual(["just now", "1 hour ago", "none"]);
  expect(interval).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(60_000));
  expect(labels(container)).toEqual(["1 minute ago", "1 hour ago", "none"]);
  unmount();
  expect(clear).toHaveBeenCalledOnce();
});

it("arms nothing for callers without a time", () => {
  const interval = vi.spyOn(globalThis, "setInterval");
  render(<Label at={undefined} />);
  expect(interval).not.toHaveBeenCalled();
});
