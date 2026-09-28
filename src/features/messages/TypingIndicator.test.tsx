// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { Profile } from "../relay/contracts";
import type { AgentLibrarySnapshot } from "../agents/library";
import { TypingIndicator } from "./TypingIndicator";

afterEach(cleanup);
it("keeps known agents out of composer typing without Activity, while preserving namesake humans and scopes", () => {
  const agent = "a".repeat(64),
    native = "b".repeat(64),
    human = "c".repeat(64);
  let profiles: ReadonlyMap<string, Profile> = new Map([
    [agent, { name: "Honey", isAgent: true }],
    [native, { name: "Native" }],
    [human, { name: "Honey" }],
  ]);
  let choices: AgentLibrarySnapshot = {
    status: "ready",
    definitions: [],
    identities: [{ pubkey: native, name: "Native" }],
  };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const ensure = vi.fn();
  const entries = [agent, native, human].map((pubkey) => ({
    pubkey,
    channelId: "alpha",
    threadRootId: "root",
  }));
  const session = {
    typing: { snapshot: () => entries, subscribe: () => () => {} },
    profiles: { snapshot: () => profiles, subscribe, ensure },
    agentChoices: { snapshot: () => choices, subscribe, ensure },
  } as unknown as RelaySession;
  const tree = (channelId = "alpha", threadRootId = "root") => (
    <TypingIndicator
      session={session}
      channelId={channelId}
      threadRootId={threadRootId}
    />
  );
  const view = render(tree(), { reactStrictMode: true });
  expect(
    screen.getByRole("status", { name: "Typing activity" }).textContent,
  ).toBe("Honey is typing…");
  view.rerender(tree("alpha", "sibling"));
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(tree());
  // Newly acquired display evidence removes an initially unknown typer.
  act(() => {
    profiles = new Map([
      ...profiles,
      [human, { name: "Honey", isAgent: true }],
    ]);
    for (const fn of listeners) fn();
  });
  expect(screen.queryByRole("status")).toBeNull();
  // Losing an inventory does not retain stale hidden identities.
  act(() => {
    choices = { status: "unavailable", definitions: [], identities: [] };
    for (const fn of listeners) fn();
  });
  expect(screen.getByRole("status").textContent).toBe("Native is typing…");
  expect(ensure).not.toHaveBeenCalled();
});
