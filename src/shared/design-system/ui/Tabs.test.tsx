// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { Tabs, type TabItem } from "./Tabs";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

/**
 * jsdom has no layout, and revealing a tab is a question about geometry. So the
 * strip is given one: a 200px window onto 100px tabs that move as it scrolls,
 * which is the only part of the browser this behaviour actually depends on.
 */
function layOut(strip: HTMLElement, width = 200, tab = 100) {
  const pills = () =>
    [
      ...strip.querySelectorAll<HTMLElement>(".buzz-tabs-item, .buzz-tabs-tab"),
    ].filter(
      (element) =>
        !element.closest(".buzz-tabs-item") ||
        element.classList.contains("buzz-tabs-item"),
    );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === strip) return { left: 0, right: width, width } as DOMRect;
      const index = pills().indexOf(this);
      if (index < 0) return { left: 0, right: 0, width: 0 } as DOMRect;
      const left = index * tab - strip.scrollLeft;
      return { left, right: left + tab, width: tab } as DOMRect;
    },
  );
  return pills;
}

const agents = ["Thread", "Carl", "Vogue"];
const dismissible: readonly TabItem<string>[] = agents.map((label) => ({
  value: label.toLowerCase(),
  label,
  dismiss: { label: `Close ${label} tab`, onDismiss: () => {} },
}));

test("a selected tab outside the visible strip is revealed without moving the page", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  const view = render(
    <Tabs
      label="Panel tabs"
      variant="pill"
      value="thread"
      items={dismissible}
      onValueChange={() => {}}
    />,
  );
  const strip = screen.getByRole("tablist", { name: "Panel tabs" });
  layOut(strip);
  // The third pill sits entirely past the right edge — the 390px-wide failure.
  view.rerender(
    <Tabs
      label="Panel tabs"
      variant="pill"
      value="vogue"
      items={dismissible}
      onValueChange={() => {}}
    />,
  );
  await waitFor(() => expect(strip.scrollLeft).toBe(100));
  const pill = screen.getByRole("tab", { name: "Vogue" }).parentElement;
  expect(pill?.getBoundingClientRect().right).toBeLessThanOrEqual(200);
  // Only the strip moves: scrollIntoView would also scroll the panel and page.
  expect(scrollIntoView).not.toHaveBeenCalled();
});

test("a tab that scrolled off the start is revealed from the left", async () => {
  const view = render(
    <Tabs
      label="Panel tabs"
      variant="pill"
      value="vogue"
      items={dismissible}
      onValueChange={() => {}}
    />,
  );
  const strip = screen.getByRole("tablist", { name: "Panel tabs" });
  layOut(strip);
  strip.scrollLeft = 100;
  view.rerender(
    <Tabs
      label="Panel tabs"
      variant="pill"
      value="thread"
      items={dismissible}
      onValueChange={() => {}}
    />,
  );
  await waitFor(() => expect(strip.scrollLeft).toBe(0));
});

test("non-dismissible sections are revealed the same way", async () => {
  const sections = ["Info", "Runtime", "Channels", "Activity", "Memories"].map(
    (label) => ({ value: label.toLowerCase(), label }),
  );
  const view = render(
    <Tabs
      label="Profile sections"
      variant="panel"
      value="info"
      items={sections}
      onValueChange={() => {}}
    />,
  );
  const strip = screen.getByRole("tablist", { name: "Profile sections" });
  layOut(strip);
  view.rerender(
    <Tabs
      label="Profile sections"
      variant="panel"
      value="memories"
      items={sections}
      onValueChange={() => {}}
    />,
  );
  await waitFor(() => expect(strip.scrollLeft).toBe(300));
});

test("closing an earlier tab re-reveals a selection that never changed", async () => {
  /* The selected value is identical across this rerender: only the list moved.
     A reveal keyed on selection alone would miss it, which is the case a person
     hits every time they dismiss a tab to the left of the one they are reading. */
  const four = ["Thread", "Carl", "Mordecai", "Vogue"].map((label) => ({
    value: label.toLowerCase(),
    label,
    dismiss: { label: `Close ${label} tab`, onDismiss: () => {} },
  }));
  const view = render(
    <Tabs
      label="Panel tabs"
      variant="pill"
      value="vogue"
      items={four}
      onValueChange={() => {}}
    />,
  );
  const strip = screen.getByRole("tablist", { name: "Panel tabs" });
  layOut(strip);
  view.rerender(
    <Tabs
      label="Panel tabs"
      variant="pill"
      value="vogue"
      items={four.filter((item) => item.value !== "carl")}
      onValueChange={() => {}}
    />,
  );
  await waitFor(() => expect(strip.scrollLeft).toBe(100));
});
