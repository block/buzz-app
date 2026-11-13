// @vitest-environment jsdom
import { afterEach, assert, expect, test } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "../relay/events";
import { createOutbox, type Outbox, type OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import { flush, keypair, signed } from "../relay/testing";
import { readView, writeView } from "../../shared/view-state";
import { readThreadTabName, retainThreadTabNames } from "./thread-tab-names";

afterEach(() => localStorage.clear());

type Confirmed = Pick<RelayEvent, "kind" | "tags" | "created_at">;
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
    const created_at = Math.floor(Date.now() / 1000);
    for (const listener of confirmations) listener({ kind, tags, created_at });
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
    "alpha:r1": ["Launch plan", 0],
    "alpha:r2": ["Retro", 0],
    "beta:r1": ["Elsewhere", 0],
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
    "alpha:r2": ["Retro", 0],
    "beta:r1": ["Elsewhere", 0],
  });
});

test("a fresh session forgets every name of a channel deleted or left", () => {
  const scope = crypto.randomUUID();
  writeView(scope, "tab-names", {
    "alpha:r1": ["Launch plan", 0],
    "alpha:r2": ["", 0],
    "beta:r1": ["Elsewhere", 0],
  });
  const h = fresh(scope);
  retainThreadTabNames(h.session);
  h.remove("alpha");
  expect(readView(scope, "tab-names", {})).toEqual({
    "beta:r1": ["Elsewhere", 0],
  });
});

test("a session without a viewer observes nothing", () => {
  const h = fresh("undefined:undefined", "");
  retainThreadTabNames(h.session);
  expect(h.confirmations.size).toBe(0);
});

const viewer = keypair();
/** One app launch's outbox over a journal that outlives it. */
function journal() {
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const launch = (
    publish: (event: RelayEvent) => Promise<void>,
    needsReceipt = false,
  ) =>
    createOutbox(
      viewer.pubkey,
      {
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish,
      },
      storage,
      { needsReceipt: () => needsReceipt },
    );
  return { launch, records: () => records };
}
const retain = (scope: string, outbox: Outbox) =>
  retainThreadTabNames({
    scope,
    viewer: viewer.pubkey,
    outbox,
  } as unknown as RelaySession);
const deleteR1 = (outbox: Outbox) =>
  outbox.send({
    kind: 5,
    content: "",
    tags: [
      ["h", "alpha"],
      ["e", "r1"],
    ],
  });
const names = (scope: string) => readView(scope, "tab-names", {});

test.each([false, true])(
  "a newer name survives the deletion's second confirmation (receipt required: %s)",
  async (needsReceipt) => {
    const scope = crypto.randomUUID();
    writeView(scope, "tab-names", { "alpha:r1": ["Launch plan", 0] });
    let receive = () => {};
    const { launch, records } = journal();
    const h = launch(
      () => new Promise<void>((resolve) => (receive = resolve)),
      needsReceipt,
    );
    retain(scope, h.outbox);
    deleteR1(h.outbox);
    await flush();
    const deletion = records()[0]?.signed;
    assert.exists(deletion);
    // The first confirmation, by receipt or by echo, forgets the name.
    if (needsReceipt) h.observe([deletion]);
    else receive();
    await flush();
    expect(names(scope)).toEqual({});
    // Renamed in a later second than the deletion.
    writeView(scope, "tab-names", { "alpha:r1": ["Newer", Date.now() + 1000] });
    // The other confirmation of the same deletion keeps the newer name.
    if (needsReceipt) receive();
    else h.observe([deletion]);
    await flush();
    expect(h.outbox.snapshot()).toEqual([]);
    expect(readThreadTabName(scope, "alpha:r1")).toBe("Newer");
    h.dispose();
  },
);

test("a deletion confirmed before a restart keeps a newer name when its echo arrives after", async () => {
  const scope = crypto.randomUUID();
  writeView(scope, "tab-names", { "alpha:r1": ["Launch plan", 0] });
  const { launch, records } = journal();
  const first = launch(async () => {});
  retain(scope, first.outbox);
  deleteR1(first.outbox);
  await flush();
  expect(first.outbox.snapshot()).toMatchObject([{ delivery: "accepted" }]);
  expect(names(scope)).toEqual({});
  const deletion = records()[0]?.signed;
  assert.exists(deletion);
  first.dispose();
  // Renamed in a later second than the deletion.
  writeView(scope, "tab-names", { "alpha:r1": ["Newer", Date.now() + 1000] });
  const second = launch(async () => {});
  retain(scope, second.outbox);
  await second.outbox.ready();
  second.observe([deletion]);
  expect(second.outbox.snapshot()).toEqual([]);
  expect(readThreadTabName(scope, "alpha:r1")).toBe("Newer");
  second.dispose();
});

test("a newer name survives a deletion confirmed again after two restarts", async () => {
  const scope = crypto.randomUUID();
  writeView(scope, "tab-names", { "alpha:r1": ["Launch plan", 0] });
  const { launch, records } = journal();
  const first = launch(async () => {});
  retain(scope, first.outbox);
  deleteR1(first.outbox);
  await flush();
  expect(names(scope)).toEqual({});
  const deletion = records()[0]?.signed;
  assert.exists(deletion);
  first.dispose();
  writeView(scope, "tab-names", { "alpha:r1": ["Newer", Date.now() + 1000] });
  // An unrelated send saves the restored deletion again, as unknown.
  const second = launch(() => new Promise<void>(() => {}));
  retain(scope, second.outbox);
  await second.outbox.ready();
  second.outbox.send({ kind: 9, content: "hello", tags: [["h", "alpha"]] });
  await flush();
  second.dispose();
  const third = launch(async () => {});
  retain(scope, third.outbox);
  await third.outbox.ready();
  third.observe([deletion]);
  expect(readThreadTabName(scope, "alpha:r1")).toBe("Newer");
  third.dispose();
});

test("a deletion recovered after a restart forgets its name once confirmed, and only then", async () => {
  const scope = crypto.randomUUID();
  writeView(scope, "tab-names", { "alpha:r1": ["Launch plan", 0] });
  const { launch, records: saved } = journal();
  // The deletion is sent, but the app quits before the relay answers.
  const first = launch(() => new Promise<void>(() => {}));
  const id = deleteR1(first.outbox);
  await flush();
  const deletion = saved()[0]?.signed;
  assert.exists(deletion);
  first.dispose();
  // The next launch restores it without capturing a fresh send.
  const second = launch(async () => {});
  retain(scope, second.outbox);
  await second.outbox.ready();
  expect(second.outbox.snapshot()).toMatchObject([{ event: { id } }]);
  expect(readView(scope, "tab-names", {})).toEqual({
    "alpha:r1": ["Launch plan", 0],
  });
  second.observe([deletion]);
  expect(second.outbox.snapshot()).toEqual([]);
  expect(readView(scope, "tab-names", {})).toEqual({});
  second.dispose();
});
