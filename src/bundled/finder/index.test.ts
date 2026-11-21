// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { apply } from "./index";
import { topInterest } from "./interest";

const viewer = "a".repeat(64);
const communityOrigin = "https://relay.example.org";
const scope = `${communityOrigin}:${viewer}`;
afterEach(() => localStorage.clear());

function mount() {
  const listeners = new Set<() => void>();
  let entry: { id: string; target: unknown } = {
    id: "home",
    target: { kind: "home" },
  };
  const stop: (() => void)[] = [];
  apply({
    relay: {
      snapshot: () => ({ status: "connecting" }),
      subscribe: () => () => {},
    },
    navigation: {
      snapshot: () => ({ entry }),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    pages: { registerOverlay() {} },
    shortcuts: { register() {} },
    effect: (body: () => () => void) => void stop.push(body()),
  } as unknown as Parameters<typeof apply>[0]);
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const visit = (id: string, channelId: string) => {
    entry = {
      id,
      target: {
        kind: "conversation",
        scope: { viewer, communityOrigin },
        channelId,
      },
    };
    notify();
  };
  return {
    visit,
    notify,
    dispose: () => {
      for (const body of stop) body();
    },
  };
}

test("counts each visit to a conversation once", () => {
  const { visit, notify, dispose } = mount();
  visit("v1", "busy");
  // Navigation also notifies for attempts and other changes to one visit.
  notify();
  notify();
  visit("v2", "quiet");
  visit("v3", "quiet");
  expect(topInterest(scope, 5)).toEqual(["quiet", "busy"]);
  dispose();
  visit("v4", "busy");
  visit("v5", "busy");
  expect(topInterest(scope, 5)).toEqual(["quiet", "busy"]);
});
