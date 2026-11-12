// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileLocalTime } from "./ProfileLocalTime";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("refreshes at each minute boundary and stops when unmounted", () => {
  vi.useFakeTimers({ now: new Date("2026-01-15T15:41:30Z") });
  const view = render(
    <ProfileLocalTime timeZone="UTC" className="local-time" />,
  );
  const time = () => screen.getByText(/local time/).textContent;
  expect(time()).toMatch(/3:41|15:41/);
  act(() => vi.advanceTimersByTime(29_999));
  expect(time()).toMatch(/3:41|15:41/);
  act(() => vi.advanceTimersByTime(1));
  expect(time()).toMatch(/3:42|15:42/);
  act(() => vi.advanceTimersByTime(60_000));
  expect(time()).toMatch(/3:43|15:43/);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("renders nothing and schedules nothing for an unknown zone", () => {
  vi.useFakeTimers({ now: new Date("2026-01-15T15:41:30Z") });
  const { container } = render(
    <ProfileLocalTime timeZone="Mars/Olympus" className="local-time" />,
  );
  expect(container).toBeEmptyDOMElement();
  expect(vi.getTimerCount()).toBe(0);
});
