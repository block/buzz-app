// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
import { TypingIndicator } from "./TypingIndicator";

afterEach(cleanup);
const agent = "a".repeat(64),
  human = "b".repeat(64);
function fixture() {
  const listeners = new Set<() => void>();
  let typing: readonly TypingEntry[] = [];
  let activity = {
    typing: [] as { agent: string; channelId: string; threadRootId?: string }[],
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const profiles = new Map([
    [agent, { name: "Agent" }],
    [human, { name: "Human" }],
  ]);
  const session = {
    typing: { snapshot: () => typing, subscribe },
    agentActivity: { snapshot: () => activity, subscribe },
    profiles: { snapshot: () => profiles, subscribe },
  } as unknown as RelaySession;
  return {
    session,
    update(entries: readonly TypingEntry[], agents: typeof activity.typing) {
      act(() => {
        typing = entries;
        activity = { typing: agents };
        for (const listener of listeners) listener();
      });
    },
  };
}
it("omits only identities represented by available exact-thread activity rows and restores public typing", () => {
  const f = fixture();
  const canOpen = vi.fn(() => true);
  const props = {
    session: f.session,
    channelId: "channel",
    threadRootId: "root",
    canOpenActivity: canOpen,
  };
  const view = render(<TypingIndicator {...props} />);
  expect(screen.queryByRole("status")).toBeNull();
  const entries = [agent, human].map((pubkey) => ({
    pubkey,
    channelId: "channel",
    threadRootId: "root",
  }));
  f.update(entries, [{ agent, channelId: "channel", threadRootId: "other" }]);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent, Human are typing",
  );
  f.update(entries, [{ agent, channelId: "other", threadRootId: "root" }]);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent, Human are typing",
  );
  f.update(entries, [{ agent, channelId: "channel", threadRootId: "root" }]);
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  f.update(entries.slice(0, 1), [
    { agent, channelId: "channel", threadRootId: "root" },
  ]);
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<TypingIndicator {...props} canOpenActivity={() => false} />);
  expect(screen.getByRole("status")).toHaveTextContent("Agent is typing");
  view.rerender(<TypingIndicator {...props} />);
  f.update(entries.slice(0, 1), []); // Plugin disabled: public activity is still useful.
  expect(screen.getByRole("status")).toHaveTextContent("Agent is typing");
  view.rerender(<TypingIndicator {...props} threadRootId="other" />);
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<TypingIndicator {...props} channelId="other" />);
  expect(screen.queryByRole("status")).toBeNull();
  f.update([], []);
  view.rerender(<TypingIndicator {...props} />);
  expect(screen.queryByRole("status")).toBeNull();
});
it("deduplicates main-channel agents while retaining human typing and unavailable fallback", () => {
  const f = fixture();
  const view = render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => true}
    />,
  );
  f.update(
    [{ pubkey: agent, channelId: "channel" }],
    [{ agent, channelId: "channel" }],
  );
  expect(screen.queryByRole("status")).toBeNull();
  f.update(
    [
      { pubkey: agent, channelId: "channel" },
      { pubkey: human, channelId: "channel" },
    ],
    [{ agent, channelId: "channel" }],
  );
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent, Human are typing",
  );
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => true}
    />,
  );
  f.update([{ pubkey: agent, channelId: "channel" }], []);
  expect(screen.getByRole("status")).toHaveTextContent("Agent is typing");
});
