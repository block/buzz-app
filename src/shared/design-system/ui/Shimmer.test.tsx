// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Shimmer } from "./Shimmer";

afterEach(cleanup);

it("preserves text, caller styling and semantics when activity changes", () => {
  const view = render(
    <Shimmer className="text-subtle" title="Live action">
      Working…
    </Shimmer>,
  );
  const label = screen.getByText("Working…");
  expect(label.classList.contains("text-subtle")).toBe(true);
  expect(label.title).toBe("Live action");
  expect(label.hasAttribute("data-active")).toBe(true);
  expect(label.hasAttribute("role")).toBe(false);
  view.rerender(<Shimmer active={false}>Working…</Shimmer>);
  expect(screen.getByText("Working…")).toBe(label);
  expect(label.hasAttribute("data-active")).toBe(false);
});
