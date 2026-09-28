// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageTimestamp } from "./MessageTimestamp";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 24, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it.each([
  [new Date(2026, 8, 24, 9, 5), "Today at"],
  [new Date(2026, 8, 23, 9, 5), "Yesterday at"],
  [new Date(2026, 8, 17, 9, 5), "Sep 17 at"],
  [new Date(2025, 8, 17, 9, 5), "Sep 17, 2025 at"],
])("gives %s day context and a full accessible date", (date, label) => {
  const { container } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    date.toISOString(),
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    label,
  );
  expect(
    screen.getByText(
      date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
    ),
  ).toHaveClass("sr-only");
});
it("keeps the continuation clock compact without dropping its accessible date", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} compact />,
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    /^9:05$/,
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent("2026");
});
