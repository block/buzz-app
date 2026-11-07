// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import type { RelaySession } from "../relay/session";
import { AgentResponsePreview } from "./AgentResponsePreview";
import { fixture } from "./typing-indicator-testing";

stubAvatarBrowserApis();
afterEach(cleanup);

type Agent = { id: string; name: string };
const agent = (digit: string): Agent => ({
  id: digit.repeat(64),
  name: `Agent ${digit}`,
});
// Ordered by key, as working rows order their agents.
const first = agent("0"),
  second = agent("1"),
  third = agent("2"),
  fourth = agent("3");

function row(
  session: RelaySession,
  [named, ...others]: readonly [Agent, ...Agent[]],
  stackPrevious = false,
) {
  return (
    <AgentResponsePreview
      name={named.name}
      participants={[named, ...others]}
      stackPrevious={stackPrevious}
      profile={{
        pubkey: named.id,
        session,
        channelId: "channel",
        canOpen: () => true,
        open: () => true,
      }}
    >
      <button type="button">Activity</button>
    </AgentResponsePreview>
  );
}

it("keeps a focused avatar shown while agents ahead of it fill the group", () => {
  const { session } = fixture();
  const view = render(row(session, [fourth]));
  const avatar = screen.getByRole("button", { name: "View Agent 3 profile" });
  act(() => avatar.focus());
  view.rerender(row(session, [second, third, fourth]));
  view.rerender(row(session, [first, second, third, fourth]));
  expect(avatar).toHaveFocus();
  // It takes the third place from the agent it sorts after.
  expect(screen.getByTitle("Agent 0")).toBeVisible();
  expect(screen.getByTitle("Agent 1")).toBeVisible();
  expect(screen.queryByTitle("Agent 2")).toBeNull();
});

it.each([
  ["the remaining agent's avatar", [second], "View Agent 1 profile"],
  ["the bubble's control", [second, third], "Activity"],
] as const)(
  "hands a focused avatar whose agent stops to %s",
  (_, remaining, successor) => {
    const { session } = fixture();
    const view = render(row(session, [first]));
    const avatar = screen.getByRole("button", { name: "View Agent 0 profile" });
    act(() => avatar.focus());
    view.rerender(row(session, [first, ...remaining]));
    expect(avatar).toHaveFocus();
    view.rerender(row(session, remaining));
    expect(avatar.isConnected).toBe(false);
    expect(screen.getByRole("button", { name: successor })).toHaveFocus();
  },
);

it("keeps a compact continuation's hidden avatar a labelled image, not a hidden profile control", () => {
  const { session } = fixture();
  const root = document.documentElement;
  root.dataset.messageDensity = "compact";
  try {
    render(
      <AgentResponsePreview
        name={first.name}
        participants={[first]}
        stackPrevious
        profile={{
          pubkey: first.id,
          session,
          channelId: "channel",
          canOpen: () => true,
          open: () => true,
        }}
      >
        <button type="button">Activity</button>
      </AgentResponsePreview>,
    );
    expect(
      screen.queryByRole("button", { name: "View Agent 0 profile" }),
    ).toBeNull();
    const avatar = screen.getByRole("img", { name: "Agent 0" });
    expect(avatar.parentElement).toHaveClass("sr-only");
  } finally {
    delete root.dataset.messageDensity;
  }
});

it("keeps a focused avatar shown as its compact row becomes a continuation, then hides it once focus moves on", () => {
  const { session } = fixture();
  const root = document.documentElement;
  root.dataset.messageDensity = "compact";
  const view = (stackPrevious: boolean) => (
    <>
      <button type="button">Elsewhere</button>
      {row(session, [first], stackPrevious)}
    </>
  );
  try {
    const { rerender } = render(view(false));
    const avatar = screen.getByRole("button", { name: "View Agent 0 profile" });
    act(() => avatar.focus());
    rerender(view(true));
    // Hiding it now would leave keyboard focus on an invisible control.
    expect(avatar).toHaveFocus();
    expect(avatar.closest(".sr-only")).toBeNull();
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    expect(
      screen.queryByRole("button", { name: "View Agent 0 profile" }),
    ).toBeNull();
    expect(
      screen.getByRole("img", { name: "Agent 0" }).parentElement,
    ).toHaveClass("sr-only");
  } finally {
    delete root.dataset.messageDensity;
  }
});
