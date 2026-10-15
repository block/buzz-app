// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
import { JumpToLatestButton } from "./JumpToLatestButton";

afterEach(cleanup);
const agent = "a".repeat(64);
const root = "d".repeat(64);
const library = { identities: [{ pubkey: agent }] };
function fixture() {
  const listeners = new Set<() => void>();
  let typing: readonly TypingEntry[] = [];
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const session = {
    typing: { snapshot: () => typing, subscribe },
    agentChoices: { snapshot: () => library, subscribe },
  } as unknown as RelaySession;
  return {
    session,
    listeners,
    update(entries: readonly TypingEntry[]) {
      act(() => {
        typing = entries;
        for (const listener of listeners) listener();
      });
    },
  };
}
const lane = () =>
  screen
    .getByRole("button", { name: "Jump to latest" })
    .closest("[data-visible]");
const props = { visible: true, newMessageCount: 0, onClick() {} };

it("reserves the lane while agents work in the conversation and releases it after", () => {
  const f = fixture();
  render(
    <JumpToLatestButton
      {...props}
      activityLane={{ session: f.session, channelId: "channel" }}
    />,
  );
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  f.update([{ pubkey: agent, channelId: "channel", threadRootId: root }]);
  expect(lane()).toHaveAttribute("data-activity-lane");
  f.update([]);
  expect(lane()).not.toHaveAttribute("data-activity-lane");
});

it("scopes a thread lane to that thread's activity", () => {
  const f = fixture();
  render(
    <JumpToLatestButton
      {...props}
      activityLane={{
        session: f.session,
        channelId: "channel",
        threadRootId: root,
      }}
    />,
  );
  f.update([{ pubkey: agent, channelId: "channel" }]);
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  f.update([{ pubkey: agent, channelId: "channel", threadRootId: root }]);
  expect(lane()).toHaveAttribute("data-activity-lane");
});

it("neither reserves the lane nor subscribes to typing state without a lane", () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel" }]);
  render(<JumpToLatestButton {...props} />);
  expect(lane()).not.toHaveAttribute("data-activity-lane");
  expect(f.listeners.size).toBe(0);
});
