// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { TabbedPanel, type PanelTab } from "./TabbedPanel";
import { Input } from "../../shared/design-system/ui/Input";

afterEach(cleanup);

test("adding, switching, and closing a tab preserves the original view and draft", async () => {
  const user = userEvent.setup();
  const dispose = vi.fn();
  const closePanel = vi.fn();
  function Thread() {
    useEffect(() => dispose, []);
    return <Input aria-label="Thread draft" />;
  }
  function Example() {
    const [activity, setActivity] = useState(false);
    const [selected, select] = useState("thread");
    const tabs: PanelTab[] = [
      { value: "thread", label: "Thread", content: <Thread />, close: vi.fn() },
    ];
    if (activity)
      tabs.push({
        value: "activity",
        label: "Activity",
        content: <Input aria-label="Activity filter" />,
        close: () => {
          setActivity(false);
          select("thread");
        },
      });
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setActivity(true);
            select("activity");
          }}
        >
          Open activity
        </button>
        <TabbedPanel
          tabs={tabs}
          value={selected}
          onValueChange={select}
          onClose={closePanel}
        />
      </>
    );
  }
  render(<Example />);
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  const thread = screen.getByRole("tabpanel", { name: "Thread" });
  await user.type(draft, "Unfinished reply");
  await user.click(screen.getByRole("button", { name: "Open activity" }));
  expect(thread).toHaveAttribute("inert");
  expect(thread).toHaveAttribute("aria-hidden", "true");
  expect(thread).not.toHaveAttribute("hidden");
  expect(screen.queryByRole("textbox", { name: "Thread draft" })).toBeNull();
  await user.type(
    screen.getByRole("textbox", { name: "Activity filter" }),
    "tool",
  );
  await user.click(screen.getByRole("tab", { name: "Thread" }));
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toBe(draft);
  expect(draft).toHaveValue("Unfinished reply");
  await user.keyboard("{ArrowRight}{Enter}");
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("textbox", { name: "Activity filter" })).toHaveValue(
    "tool",
  );
  await user.click(screen.getByRole("button", { name: "Open activity" }));
  expect(screen.getAllByRole("tab", { name: "Activity" })).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Activity filter" })).toHaveValue(
    "tool",
  );
  await user.click(screen.getByRole("button", { name: "Close Activity tab" }));
  expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toBe(draft);
  expect(draft).toHaveValue("Unfinished reply");
  expect(dispose).not.toHaveBeenCalled();
  expect(closePanel).not.toHaveBeenCalled();
});

test("Escape and the trailing control close the panel, not one tab", async () => {
  const user = userEvent.setup();
  const closePanel = vi.fn(),
    closeThread = vi.fn(),
    closeActivity = vi.fn();
  const tabs = [
    {
      value: "thread",
      label: "Thread",
      content: "Thread content",
      close: closeThread,
    },
    {
      value: "activity",
      label: "Activity",
      content: "Activity content",
      close: closeActivity,
    },
  ];
  const view = render(
    <TabbedPanel
      tabs={tabs}
      value="activity"
      onValueChange={vi.fn()}
      onClose={closePanel}
    />,
  );
  // Opening presents the view a person asked for, not the control that closes it.
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(closePanel).toHaveBeenCalledOnce();
  expect(closeActivity).not.toHaveBeenCalled();
  expect(closeThread).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Close panel" }));
  expect(closePanel).toHaveBeenCalledTimes(2);
  expect(closeActivity).not.toHaveBeenCalled();
  // Each tab keeps its own dismissal, including the one not being read.
  await user.click(screen.getByRole("button", { name: "Close Thread tab" }));
  expect(closeThread).toHaveBeenCalledOnce();
  expect(closePanel).toHaveBeenCalledTimes(2);
  view.rerender(
    <TabbedPanel
      tabs={tabs.slice(0, 1)}
      value="activity"
      onValueChange={vi.fn()}
      onClose={closePanel}
    />,
  );
  expect(screen.getByRole("tab", { name: "Thread" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

/**
 * One panel with two tabs, where each tab's `close` both removes it and restores
 * focus to the control that opened it — which is what the real page does, and is
 * outside this panel.
 */
function twoTabPanel(selected: string) {
  const outside = document.createElement("button");
  outside.textContent = "Originating control";
  document.body.append(outside);
  function Example() {
    const [open, setOpen] = useState(["activity", "thread"]);
    const tabs: PanelTab[] = open.map((value) => ({
      value,
      label: value === "activity" ? "Activity" : "Thread",
      content: `${value} content`,
      close: () => {
        setOpen((previous) => previous.filter((tab) => tab !== value));
        outside.focus();
      },
    }));
    return (
      <TabbedPanel
        tabs={tabs}
        value={selected}
        onValueChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
  }
  render(<Example />);
  return outside;
}

// Whichever tab is dismissed, a person stays in the panel while one remains:
// the page's own focus restoration is for the panel going away, not for this.
test("dismissing the inactive tab keeps focus on the tab still open", async () => {
  const user = userEvent.setup();
  const outside = twoTabPanel("activity");
  await user.click(screen.getByRole("button", { name: "Close Thread tab" }));
  expect(screen.queryByRole("tab", { name: "Thread" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  outside.remove();
});

test("dismissing the active tab focuses the tab selection falls back to", async () => {
  const user = userEvent.setup();
  const outside = twoTabPanel("thread");
  expect(screen.getByRole("tab", { name: "Thread" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Close Thread tab" }));
  expect(screen.queryByRole("tab", { name: "Thread" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  outside.remove();
});

// Closing a routed view navigates first and drops the tab on a later commit, so
// the panel renders at least once with the dismissed tab still listed. Focus has
// to wait for the tab to actually leave rather than for the next render.
test("dismissal that removes the tab a render later still reclaims focus", async () => {
  const user = userEvent.setup();
  const outside = document.createElement("button");
  document.body.append(outside);
  function Example() {
    const [open, setOpen] = useState(["activity", "thread"]);
    const [navigating, navigate] = useState(false);
    useEffect(() => {
      if (navigating) setOpen(["activity"]);
    }, [navigating]);
    const tabs: PanelTab[] = open.map((value) => ({
      value,
      label: value === "activity" ? "Activity" : "Thread",
      content: `${value} content`,
      close: () => {
        navigate(true);
        outside.focus();
      },
    }));
    return (
      <TabbedPanel
        tabs={tabs}
        value="thread"
        onValueChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Close Thread tab" }));
  expect(screen.queryByRole("tab", { name: "Thread" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  outside.remove();
});
