// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import { retainThreadTabNames } from "./thread-tab-names";

afterEach(() => localStorage.clear());

type Send = (event: {
  kind: number;
  tags: string[][];
}) => (() => void) | undefined;
/** A fresh session that has opened no tab workspace. */
function fresh(scope: string, viewer = "viewer") {
  const removals = new Set<(channelId: string) => void>();
  const sends = new Set<Send>();
  const session = {
    scope,
    viewer,
    channelLifecycle: {
      observeRemoval(listener: (channelId: string) => void) {
        removals.add(listener);
        return () => removals.delete(listener);
      },
    },
    outbox: {
      observeSend(listener: Send) {
        sends.add(listener);
        return () => sends.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const send = (kind: number, tags: string[][]) =>
    [...sends].map((listener) => listener({ kind, tags }));
  const remove = (channelId: string) => {
    for (const listener of removals) listener(channelId);
  };
  return { session, send, remove, sends };
}

test("a fresh session forgets a deleted thread's name once the relay has it", () => {
  const scope = crypto.randomUUID();
  const names = {
    "alpha:r1": "Launch plan",
    "alpha:r2": "Retro",
    "beta:r1": "Elsewhere",
  };
  // Saved by an earlier launch.
  writeView(scope, "tab-names", names);
  const h = fresh(scope);
  retainThreadTabNames(h.session);
  const deleted = h.send(5, [
    ["h", "alpha"],
    ["e", "r1"],
  ]);
  expect(h.send(9, [["h", "alpha"]])).toEqual([undefined]);
  expect(h.send(5, [["e", "r2"]])).toEqual([undefined]);
  // Pending, or refused and never received: the name stays.
  expect(readView(scope, "tab-names", {})).toEqual(names);
  for (const received of deleted) received?.();
  expect(readView(scope, "tab-names", {})).toEqual({
    "alpha:r2": "Retro",
    "beta:r1": "Elsewhere",
  });
});

test("a fresh session forgets every name of a channel deleted or left", () => {
  const scope = crypto.randomUUID();
  writeView(scope, "tab-names", {
    "alpha:r1": "Launch plan",
    "alpha:r2": "",
    "beta:r1": "Elsewhere",
  });
  const h = fresh(scope);
  retainThreadTabNames(h.session);
  h.remove("alpha");
  expect(readView(scope, "tab-names", {})).toEqual({ "beta:r1": "Elsewhere" });
});

test("a session without a viewer observes nothing", () => {
  const h = fresh("undefined:undefined", "");
  retainThreadTabNames(h.session);
  expect(h.sends.size).toBe(0);
});
