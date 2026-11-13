// @vitest-environment jsdom
import { afterEach, assert, expect, test } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "../relay/events";
import { createOutbox, type OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import { flush, keypair, signed } from "../relay/testing";
import { readView, writeView } from "../../shared/view-state";
import { retainThreadTabNames } from "./thread-tab-names";

afterEach(() => localStorage.clear());

type Confirmed = Pick<RelayEvent, "kind" | "tags">;
/** A fresh session that has opened no tab workspace. */
function fresh(scope: string, viewer = "viewer") {
  const removals = new Set<(channelId: string) => void>();
  const confirmations = new Set<(event: Confirmed) => void>();
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
      observeDelivered(listener: (event: Confirmed) => void) {
        confirmations.add(listener);
        return () => confirmations.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const confirm = (kind: number, tags: string[][]) => {
    for (const listener of confirmations) listener({ kind, tags });
  };
  const remove = (channelId: string) => {
    for (const listener of removals) listener(channelId);
  };
  return { session, confirm, remove, confirmations };
}

test("a fresh session forgets a deleted thread's name once the relay confirms it", () => {
  const scope = crypto.randomUUID();
  // Saved by an earlier launch.
  writeView(scope, "tab-names", {
    "alpha:r1": "Launch plan",
    "alpha:r2": "Retro",
    "beta:r1": "Elsewhere",
  });
  const h = fresh(scope);
  retainThreadTabNames(h.session);
  h.confirm(9, [
    ["h", "alpha"],
    ["e", "r2"],
  ]);
  h.confirm(5, [["e", "r2"]]);
  h.confirm(5, [
    ["h", "alpha"],
    ["e", "r1"],
  ]);
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
  expect(h.confirmations.size).toBe(0);
});

test("a deletion recovered after a restart forgets its name once confirmed, and only then", async () => {
  const scope = crypto.randomUUID();
  const viewer = keypair();
  writeView(scope, "tab-names", { "alpha:r1": "Launch plan" });
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const launch = (publish: (event: RelayEvent) => Promise<void>) =>
    createOutbox(
      viewer.pubkey,
      {
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish,
      },
      storage,
    );
  // The deletion is sent, but the app quits before the relay answers.
  const first = launch(() => new Promise<void>(() => {}));
  const id = first.outbox.send({
    kind: 5,
    content: "",
    tags: [
      ["h", "alpha"],
      ["e", "r1"],
    ],
  });
  await flush();
  const deletion = records[0]?.signed;
  assert.exists(deletion);
  first.dispose();
  // The next launch restores it without capturing a fresh send.
  const second = launch(async () => {});
  retainThreadTabNames({
    scope,
    viewer: viewer.pubkey,
    outbox: second.outbox,
  } as unknown as RelaySession);
  await second.outbox.ready();
  expect(second.outbox.snapshot()).toMatchObject([{ event: { id } }]);
  expect(readView(scope, "tab-names", {})).toEqual({
    "alpha:r1": "Launch plan",
  });
  second.observe([deletion]);
  expect(second.outbox.snapshot()).toEqual([]);
  expect(readView(scope, "tab-names", {})).toEqual({});
  second.dispose();
});
