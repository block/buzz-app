// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { RequestWorkDetails } from "./RequestWorkDetails";
import type { RequestWork } from "./request-work";
import { stubPopoverBrowserApis } from "./popover-testing";
stubPopoverBrowserApis();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const session = {} as RelaySession;
const work: RequestWork = {
  requestId: "request",
  state: "ended",
  uncertain: false,
  agents: ["a", "b", "c"].map((agent) => ({
    agent,
    records: [],
    turns: [],
    state: "ended" as const,
    responseIds: [],
  })),
};
const names = new Map([
  ["a", "Same · one"],
  ["b", "Same · two"],
  ["c", "Third"],
]);
function pointer(
  target: Element,
  type: string,
  x: number,
  y: number,
  extra = {},
) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...extra,
  });
  fireEvent(target, event);
}
it("uses exact-key tabs and keeps keyboard selection, live updates and removed-agent fallback usable", async () => {
  const onAgentChange = vi.fn();
  const view = render(
    <RequestWorkDetails
      work={work}
      session={session}
      names={names}
      initialAgent="b"
      onAgentChange={onAgentChange}
    />,
  );
  expect(screen.getByRole("tab", { name: "Same · two" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Third" }));
  await user.keyboard("{Home}{Enter}");
  expect(screen.getByRole("tab", { name: "Same · one" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{End}{Enter}");
  expect(onAgentChange).toHaveBeenLastCalledWith("c");
  view.rerender(
    <RequestWorkDetails
      work={{ ...work, agents: work.agents.slice(0, 2) }}
      session={session}
      names={names}
    />,
  );
  expect(screen.getByRole("tab", { name: "Same · one" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
it("swipes one agent at a time without wrapping; ignores vertical/cancelled/mouse/multitouch and tab-strip gestures", () => {
  render(<RequestWorkDetails work={work} session={session} names={names} />);
  const surface = screen.getByText(/^Observed work/);
  const selected = (name: string) =>
    expect(screen.getByRole("tab", { name })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  pointer(surface, "pointerdown", 250, 100);
  pointer(surface, "pointerup", 120, 104);
  selected("Same · two");
  pointer(surface, "pointerdown", 250, 100);
  pointer(surface, "pointerup", 245, 240);
  selected("Same · two");
  pointer(surface, "pointerdown", 250, 100);
  pointer(surface, "pointercancel", 180, 100);
  pointer(surface, "pointerup", 120, 100);
  selected("Same · two");
  for (const extra of [{ pointerType: "mouse" }, { isPrimary: false }]) {
    pointer(surface, "pointerdown", 250, 100, extra);
    pointer(surface, "pointerup", 120, 100, extra);
    selected("Same · two");
  }
  const strip = screen.getByRole("tablist");
  pointer(strip, "pointerdown", 250, 100);
  pointer(strip, "pointerup", 120, 100);
  selected("Same · two");
  pointer(surface, "pointerdown", 250, 100);
  pointer(surface, "pointerup", 120, 100);
  selected("Third");
  pointer(surface, "pointerdown", 250, 100);
  pointer(surface, "pointerup", 120, 100);
  selected("Third");
  pointer(surface, "pointerdown", 120, 100);
  pointer(surface, "pointerup", 250, 100);
  selected("Same · two");
});
