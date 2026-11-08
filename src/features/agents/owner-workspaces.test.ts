import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerMutationCaller } from "../../buzz-mcp/client";
import { appClient } from "../../buzz-mcp/app-client";
import { callSessionTool } from "../../buzz-mcp/session-tools";
import {
  coordinate,
  emptyLineup,
  type Groups,
  type KitRecord,
  type KitValue,
  kitTag,
} from "../channel-templates/model";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { PublishRejected, type OutgoingEvent } from "../relay/outbox";
import { matchesEvent } from "../relay/projection";
import { createRelaySession } from "../relay/session";
import { keypair, signed } from "../relay/testing";
import {
  projectTemplate,
  projectTemplateId,
  workspaceCanvas,
} from "../solo/workspace";
import {
  createOwnerAccess,
  type OwnerBinding,
  type OwnerSession,
} from "./owner-access";
import type { AgentHandle } from "./service";

afterEach(() => vi.restoreAllMocks());

const community = "https://primary.example";
const agent = "b".repeat(64);
const work = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fresh = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const chat = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const stream = "33333333-3333-4333-8333-333333333333";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The owner's real session, with its Solo groups, recipe kit and outbox,
 * over an in-memory relay; channel authority comes from relay-signed
 * records. */
function fixture() {
  const viewer = keypair(),
    relay = keypair();
  let time = 1_700_000_000;
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  const events: RelayEvent[] = [];
  const install = (value: KitValue, deleted = false, createdAt = time++) => {
    const record: KitRecord = { version: 1, community, deleted, value };
    const event = signed(viewer, {
      kind: 30078,
      created_at: createdAt,
      tags: [
        ["d", coordinate(record)],
        ["t", kitTag(record)],
      ],
      content: JSON.stringify(record),
    });
    events.push(event);
    return event.id;
  };
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    events.push(event);
  });
  const prepare = vi.fn(async (record: KitRecord, _signal: AbortSignal) =>
    JSON.stringify(record),
  );
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  let journal: readonly OutgoingEvent[] = [];
  const connect = () =>
    createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: community,
        media: () => undefined,
        query,
        channelKit: {
          decode: async (rows) =>
            rows.map((event) => ({
              eventId: event.id,
              record: JSON.parse(event.content),
            })),
          prepare,
        },
        writer: {
          kinds: [30078],
          sign,
          publish,
        },
      },
      {
        outboxStorage: {
          load: async () => structuredClone(journal),
          save: async (rows) => {
            journal = structuredClone(rows);
          },
        },
      },
    );
  const owner = connect();
  const authority = (id: string, labels: string[]) => {
    const record = (kind: number, tags: string[][]) =>
      ({
        id: `${kind}${id}`.padEnd(64, "0").slice(0, 64),
        pubkey: relay.pubkey,
        kind,
        created_at: 100,
        content: "",
        tags: [["d", id], ...tags],
        sig: "",
      }) as unknown as RelayEvent;
    return [
      record(39000, [["t", "stream"], ...labels.map((l) => ["t", l])]),
      record(39001, [["p", viewer.pubkey, "owner"]]),
      record(39002, [["p", viewer.pubkey, "", "owner"]]),
    ];
  };
  const channels = [
    ...authority(chat, ["buzz.solo"]),
    ...authority(other, ["buzz.solo"]),
    ...authority(stream, []),
  ];
  const { session } = owner;
  // The owner's own session: its Solo groups and kit, and the channel list and
  // relay-signed records the owner tools check channels against.
  const ownerSession = {
    soloPreferences: session.soloPreferences,
    channelKit: session.channelKit,
    scope: session.scope,
    relayAuthor: relay.pubkey,
    channels: {
      list: () => ({
        status: "ready",
        channels: [chat, other, stream].map((id) => ({
          id,
          name: id === stream ? "Team" : "Plan",
          channelType: id === stream ? "stream" : "solo",
          members: [viewer.pubkey],
        })),
      }),
      get: () => undefined,
      ensureList: () => {},
    },
    readRemote: async (filters: readonly ReadFilter[]) =>
      channels.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
  } as unknown as OwnerSession;
  const connection = new AbortController();
  const lifetime = new AbortController();
  const first: OwnerBinding = {
    viewer: viewer.pubkey,
    origin: community,
    session: ownerSession,
    signal: connection.signal,
  };
  let binding: OwnerBinding | undefined = first;
  const access = createOwnerAccess(
    { pubkey: agent, owner: viewer.pubkey },
    () => binding,
    lifetime.signal,
  );
  const workspaces = access.workspaces;
  if (!workspaces) throw new Error("Expected owner workspaces");
  const groups = () =>
    session.channelKit
      .snapshot()
      .entries.find(
        (entry) =>
          entry.record.value.type === "groups" &&
          entry.record.value.id === "me",
      );
  const groupWrites = () =>
    publish.mock.calls.filter(([event]) =>
      event.tags.some(
        ([name, value]) => name === "d" && /:groups:me$/.test(value ?? ""),
      ),
    );
  return {
    ...owner,
    viewer,
    events,
    install,
    query,
    publish,
    prepare,
    sign,
    connect,
    journal: () => structuredClone(journal),
    access,
    workspaces,
    lifetime,
    first,
    rebind: (next: OwnerBinding | undefined) => {
      binding = next;
    },
    groups,
    groupWrites,
  };
}

const live = (signal?: AbortSignal): OwnerMutationCaller => ({
  ...(signal ? { signal } : {}),
  check: () => {},
});
const solo = (
  entries: Groups["groups"],
  assignments: Groups["assignments"] = {},
): Groups => ({ type: "groups", id: "me", groups: entries, assignments });
const template = async (id: string, name: string, canvas: string) =>
  projectTemplate(community, await projectTemplateId(id), name, {
    ...emptyLineup(),
    canvas,
  });

describe("owner workspace writes", () => {
  it.each([false, true])(
    "keeps an interrupted publication unknown and restores its exact intent (published: %s)",
    async (published) => {
      const f = fixture();
      let restarted: ReturnType<typeof f.connect> | undefined;
      const held = deferred();
      const accepted: RelayEvent[] = [];
      try {
        f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
        const turn = new AbortController();
        f.publish.mockImplementationOnce(async (event) => {
          if (published) accepted.push(event);
          await held.promise;
          throw new Error("Connection lost after dispatch");
        });
        const updating = f.workspaces.update(
          { id: work, revision: null, instructions: "Original instructions" },
          live(turn.signal),
        );
        await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
        turn.abort();
        held.resolve();
        const lost = await updating;
        const operation = lost.defaults?.operation as string;
        expect(lost).toMatchObject({
          outcome: "unconfirmed",
          defaults: { operation: expect.any(String) },
        });
        await vi.waitFor(() =>
          expect(
            f.journal().find((row) => row.event.id === operation)?.delivery,
          ).toBe("unknown"),
        );
        f.dispose();
        // The disconnected reader observes accepted events only on reconnect.
        f.events.push(...accepted);
        restarted = f.connect();
        await restarted.session.outbox?.ready();
        expect(f.publish).toHaveBeenCalledOnce();
        expect(() => restarted?.session.outbox?.retry(operation)).toThrow();
        f.rebind({
          ...f.first,
          session: {
            ...f.first.session,
            channelKit: restarted.session.channelKit,
            soloPreferences: restarted.session.soloPreferences,
          },
        });
        await expect(
          f.workspaces.update(
            {
              id: work,
              revision: null,
              instructions: "Changed instructions",
              resume: operation,
            },
            live(),
          ),
        ).rejects.toThrow(/original intent/);
        const resumed = await f.workspaces.update(
          {
            id: work,
            revision: null,
            instructions: "Original instructions",
            ...(published ? {} : { resume: operation }),
          },
          live(),
        );
        expect(resumed).toMatchObject({
          outcome: "confirmed",
          defaults: { revision: operation },
        });
        expect(f.publish).toHaveBeenCalledTimes(published ? 1 : 2);
        expect(
          new Set(f.publish.mock.calls.map(([event]) => event.id)),
        ).toEqual(new Set([operation]));
      } finally {
        held.resolve();
        restarted?.dispose();
        f.dispose();
      }
    },
  );

  it("refuses different instructions on the same resumed operation", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      f.publish.mockRejectedValueOnce(new Error("Connection lost"));
      const lost = await f.workspaces.update(
        { id: work, revision: null, instructions: "Original instructions" },
        live(),
      );
      expect(lost.defaults?.operation).toBeDefined();
      await expect(
        f.workspaces.update(
          {
            id: work,
            revision: null,
            instructions: "Different instructions",
            resume: lost.defaults?.operation,
          },
          live(),
        ),
      ).rejects.toThrow(/original intent/);
      expect(f.publish).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it.each(
    (["failed", "unknown"] as const).flatMap((delivery) =>
      [false, true].map((resume) => ({ delivery, resume })),
    ),
  )(
    "does not confirm a $delivery removal from another device's projection or wedge later UI saves (explicit resume: $resume)",
    async ({ delivery, resume }) => {
      const f = fixture();
      try {
        f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
        const { revision } = await f.workspaces.get(work);
        f.publish.mockRejectedValueOnce(
          delivery === "failed"
            ? new PublishRejected("Not saved")
            : new Error("Connection lost"),
        );
        const lost = await f.workspaces.remove({ id: work, revision }, live());
        const operation = lost.groups?.operation as string;
        expect(operation).toBeDefined();
        const newer = f.install(
          solo([{ id: fresh, name: "Other", defaultTemplateId: "" }]),
          false,
          Math.floor(Date.now() / 1000) - 1,
        );
        const result = await f.workspaces.remove(
          { id: work, revision, ...(resume ? { resume: operation } : {}) },
          live(),
        );
        expect(result).toMatchObject({
          outcome: "unconfirmed",
          groups: { outcome: "unconfirmed" },
        });
        expect(result.groups?.revision).not.toBe(newer);
        expect(f.publish).toHaveBeenCalledOnce();
        await f.session.soloPreferences.refresh();
        await f.session.soloPreferences.assign(other, fresh);
        expect(f.publish).toHaveBeenCalledTimes(2);
        const original = f.session.outbox
          ?.snapshot()
          .find((row) => row.event.id === operation);
        if (delivery === "unknown") expect(original?.delivery).toBe("unknown");
        else expect(original).toBeUndefined();
      } finally {
        f.dispose();
      }
    },
  );

  it("requires the unfinished creation receipt before repairing missing defaults", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      await expect(
        f.workspaces.create(
          { id: work, name: "Launch", instructions: "Plan." },
          live(),
        ),
      ).rejects.toThrow(/unfinished creation/);
      expect(f.publish).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("never recreates a removed workspace from its retained matching defaults", async () => {
    const f = fixture();
    try {
      f.install(solo([]));
      f.install(await template(work, "Launch", "Plan."));
      await expect(
        f.workspaces.create(
          { id: work, name: "Launch", instructions: "Plan." },
          live(),
        ),
      ).rejects.toThrow(/retained defaults/);
      expect(f.publish).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("creates a workspace with its group and then its defaults, as New workspace saves them", async () => {
    const f = fixture();
    try {
      const made = await f.workspaces.create(
        { id: work, name: " Launch ", instructions: "Plan the launch." },
        live(),
      );
      expect(made).toMatchObject({
        workspace: work,
        outcome: "confirmed",
        groups: { outcome: "confirmed" },
        defaults: { outcome: "confirmed" },
      });
      expect(f.publish).toHaveBeenCalledTimes(2);
      await expect(f.workspaces.get(work)).resolves.toMatchObject({
        workspace: work,
        name: "Launch",
        revision: made.groups?.revision,
        defaults: {
          revision: made.defaults?.revision,
          instructions: "Plan the launch.",
          folders: [],
        },
      });
      // The app's own Solo groups read it as the owner's workspace.
      await f.session.soloPreferences.refresh();
      expect(f.session.soloPreferences.snapshot().data?.sections).toEqual([
        { id: work, name: "Launch", order: 0 },
      ]);
    } finally {
      f.dispose();
    }
  });

  it.each([false, true])(
    "answers partial when its defaults are not saved, and finishes without another group (restart: %s)",
    async (restart) => {
      const f = fixture();
      let restarted: ReturnType<typeof f.connect> | undefined;
      try {
        f.prepare.mockImplementationOnce(async (record) =>
          JSON.stringify(record),
        );
        f.prepare.mockRejectedValueOnce(new Error("Encryption is unavailable"));
        const first = await f.workspaces.create(
          { id: work, name: "Launch", instructions: "Plan." },
          live(),
        );
        expect(first).toMatchObject({
          outcome: "partial",
          groups: { outcome: "confirmed" },
          defaults: {
            outcome: "rejected",
            reason: expect.stringContaining("Encryption is unavailable"),
          },
        });
        if (restart) {
          await vi.waitFor(() =>
            expect(
              f
                .journal()
                .some(
                  (row) =>
                    row.event.id === first.groups?.revision && !!row.recovery,
                ),
            ).toBe(true),
          );
          f.dispose();
          restarted = f.connect();
          await restarted.session.outbox?.ready();
          f.rebind({
            ...f.first,
            session: {
              ...f.first.session,
              channelKit: restarted.session.channelKit,
              soloPreferences: restarted.session.soloPreferences,
            },
          });
        }
        await expect(
          f.workspaces.create(
            { id: work, name: "Launch", instructions: "Changed intent" },
            live(),
          ),
        ).rejects.toThrow(/unfinished creation/);
        const again = await f.workspaces.create(
          { id: work, name: "Launch", instructions: "Plan." },
          live(),
        );
        expect(again).toMatchObject({
          outcome: "confirmed",
          groups: { outcome: "confirmed", revision: first.groups?.revision },
          defaults: { outcome: "confirmed" },
        });
        expect(f.groupWrites()).toHaveLength(1);
      } finally {
        restarted?.dispose();
        f.dispose();
      }
    },
  );

  it("resumes an unconfirmed send by its operation instead of sending another", async () => {
    const f = fixture();
    try {
      f.publish.mockRejectedValueOnce(new Error("Connection lost"));
      const lost = await f.workspaces.create(
        { id: work, name: "Launch" },
        live(),
      );
      expect(lost).toMatchObject({
        outcome: "unconfirmed",
        groups: { outcome: "unconfirmed", operation: expect.any(String) },
      });
      const operation = lost.groups?.operation as string;
      // Admitted by the caller, so the Outbox's own Retry never replays it.
      expect(
        f.session.outbox?.snapshot().find((item) => item.event.id === operation)
          ?.guarded,
      ).toBe(true);
      const resumed = await f.workspaces.create(
        { id: work, name: "Launch", resume: operation },
        live(),
      );
      expect(resumed).toMatchObject({
        outcome: "confirmed",
        groups: { outcome: "confirmed", revision: operation },
      });
      // Every send was that one signed event.
      expect(new Set(f.groupWrites().map(([event]) => event.id))).toEqual(
        new Set([operation]),
      );
    } finally {
      f.dispose();
    }
  });

  it("refuses an update once newer defaults arrive while it is signed, sending nothing", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      f.install(await template(work, "Launch", "Old."));
      const { defaults } = await f.workspaces.get(work);
      const signing = deferred(),
        release = deferred();
      f.sign.mockImplementationOnce(async (unsigned) => {
        signing.resolve();
        await release.promise;
        return signed(f.viewer, unsigned);
      });
      const update = f.workspaces.update(
        { id: work, revision: defaults.revision, instructions: "Mine." },
        live(),
      );
      await signing.promise;
      // Another device saves newer defaults, and this window reads them.
      const newer = f.install(await template(work, "Launch", "Theirs."));
      await f.session.channelKit.refresh({ after: true });
      release.resolve();
      await expect(update).rejects.toThrow("changed before the save was sent");
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.session.outbox?.snapshot()).toEqual([]);
      await expect(f.workspaces.get(work)).resolves.toMatchObject({
        defaults: { revision: newer, instructions: "Theirs." },
      });
    } finally {
      f.dispose();
    }
  });

  it("never replays an unconfirmed update once newer defaults arrive before its retry", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      f.install(await template(work, "Launch", "Old."));
      const { defaults } = await f.workspaces.get(work);
      const args = {
        id: work,
        revision: defaults.revision,
        instructions: "Mine.",
      };
      f.publish.mockRejectedValueOnce(new Error("Connection lost"));
      const lost = await f.workspaces.update(args, live());
      const operation = lost.defaults?.operation as string;
      expect(lost).toMatchObject({
        defaults: { outcome: "unconfirmed", operation: expect.any(String) },
      });
      // Newer defaults arrive after the resume's head check, before its replay.
      const read = f.query.getMockImplementation();
      let arrived: string | undefined;
      f.query.mockImplementation(async (filters) => {
        if (
          !arrived &&
          filters.some((filter) => filter.ids?.[0] === operation)
        ) {
          arrived = f.install(await template(work, "Launch", "Theirs."));
          await f.session.channelKit.refresh({ after: true });
        }
        return (read as NonNullable<typeof read>)(filters);
      });
      const resumed = await f.workspaces.update(
        { ...args, resume: operation },
        live(),
      );
      expect(arrived).toBeDefined();
      // The earlier attempt may have reached the relay, so it stays unconfirmed.
      expect(resumed).toMatchObject({
        defaults: {
          outcome: "unconfirmed",
          reason: expect.stringContaining("changed before the save was sent"),
        },
      });
      expect(
        f.publish.mock.calls.filter(([event]) => event.id === operation),
      ).toHaveLength(1);
      await expect(f.workspaces.get(work)).resolves.toMatchObject({
        defaults: { revision: arrived, instructions: "Theirs." },
      });
    } finally {
      f.dispose();
    }
  });

  it("refuses a workspace whose ID already holds other defaults, before any group is saved", async () => {
    const f = fixture();
    try {
      f.install(await template(work, "Launch", "Someone else's"));
      await expect(
        f.workspaces.create(
          { id: work, name: "Launch", instructions: "Plan." },
          live(),
        ),
      ).rejects.toThrow("already has other new-chat defaults");
      expect(f.publish).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("refuses a move at a revision a queued window write already replaced", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      const { revision } = await f.workspaces.get(work);
      await f.session.soloPreferences.ensure();
      const window = f.session.soloPreferences.assign(other, work);
      await expect(
        f.workspaces.move({ chat, workspace: work, revision }, live()),
      ).rejects.toThrow("changed since that revision");
      await window;
      expect(f.publish).toHaveBeenCalledOnce();
      // The caller's refused move is its own to retry, never the window's.
      expect(f.session.soloPreferences.snapshot().moves).toBeUndefined();
      expect(f.session.soloPreferences.snapshot().data?.assignments).toEqual({
        [other]: work,
      });
    } finally {
      f.dispose();
    }
  });

  it.each([
    "the turn ends",
    "the run ends",
    "the owner signs out",
    "the owner reconnects",
  ] as const)(
    "sends nothing once %s before its save is signed",
    async (change) => {
      const f = fixture();
      try {
        f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
        const { revision } = await f.workspaces.get(work);
        const held = deferred();
        let preparation: AbortSignal | undefined;
        f.prepare.mockImplementationOnce(async (record, signal) => {
          preparation = signal;
          await held.promise;
          return JSON.stringify(record);
        });
        const turn = new AbortController();
        const removal = f.workspaces.remove(
          { id: work, revision },
          live(turn.signal),
        );
        await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
        if (change === "the turn ends") turn.abort();
        else if (change === "the run ends") f.lifetime.abort();
        else if (change === "the owner signs out") f.rebind(undefined);
        else f.rebind({ ...f.first, session: {} as OwnerSession });
        if (change === "the turn ends" || change === "the run ends")
          expect(preparation?.aborted).toBe(true);
        held.resolve();
        await expect(removal).rejects.toThrow();
        expect(f.publish).not.toHaveBeenCalled();
        expect(f.session.outbox?.snapshot()).toEqual([]);
      } finally {
        f.dispose();
      }
    },
  );

  it.each(["owner reconnect", "groups clear", "defaults clear"] as const)(
    "releases a save stopped by %s during signing, so the owner's next save goes out",
    async (change) => {
      const f = fixture();
      const held = deferred();
      try {
        f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
        const { revision } = await f.workspaces.get(work);
        f.sign.mockImplementationOnce(async (template) => {
          await held.promise;
          return signed(f.viewer, template);
        });
        const removal =
          change === "defaults clear"
            ? f.workspaces.update(
                { id: work, revision: null, instructions: "Plan." },
                live(),
              )
            : f.workspaces.remove({ id: work, revision }, live());
        await vi.waitFor(() => expect(f.sign).toHaveBeenCalledOnce());
        if (change === "owner reconnect")
          f.rebind({ ...f.first, session: {} as OwnerSession });
        else await f.clearCache();
        held.resolve();
        await expect(removal).rejects.toThrow("nothing was sent");
        expect(f.publish).not.toHaveBeenCalled();
        expect(f.session.outbox?.snapshot()).toEqual([]);
        f.rebind(f.first);
        await f.session.soloPreferences.refresh();
        await f.session.soloPreferences.assign(other, work);
        expect(f.publish).toHaveBeenCalledOnce();
      } finally {
        held.resolve();
        f.dispose();
      }
    },
  );

  it("removes a workspace, keeping its chats outside any workspace and its defaults", async () => {
    const f = fixture();
    try {
      f.install(
        solo([{ id: work, name: "Launch", defaultTemplateId: "" }], {
          [chat]: work,
        }),
      );
      const defaults = f.install(await template(work, "Launch", "Plan."));
      const { revision } = await f.workspaces.get(work);
      const removed = await f.workspaces.remove({ id: work, revision }, live());
      expect(removed).toMatchObject({
        outcome: "confirmed",
        groups: { outcome: "confirmed" },
      });
      expect(f.groups()?.record.value).toMatchObject({
        groups: [],
        assignments: {},
      });
      expect(
        f.session.channelKit
          .snapshot()
          .entries.some((entry) => entry.eventId === defaults),
      ).toBe(true);
      // Only the Solo groups record was written; no channel was touched.
      expect(f.publish).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it("moves one of the owner's Solo chats into a workspace and out of every one", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      const { revision } = await f.workspaces.get(work);
      const moved = await f.workspaces.move(
        { chat, workspace: work, revision },
        live(),
      );
      expect(moved).toMatchObject({ workspace: work, outcome: "confirmed" });
      expect(f.groups()?.record.value).toMatchObject({
        assignments: { [chat]: work },
      });
      const out = await f.workspaces.move(
        { chat, workspace: null, revision: moved.groups?.revision ?? null },
        live(),
      );
      expect(out).toMatchObject({ workspace: null, outcome: "confirmed" });
      expect(f.groups()?.record.value).toMatchObject({ assignments: {} });
      await expect(
        f.workspaces.move(
          {
            chat: stream,
            workspace: work,
            revision: out.groups?.revision ?? null,
          },
          live(),
        ),
      ).rejects.toThrow("not one of your owner's Solo chats");
      await expect(
        f.workspaces.move(
          { chat, workspace: fresh, revision: out.groups?.revision ?? null },
          live(),
        ),
      ).rejects.toThrow(`no Solo workspace ${fresh}`);
      expect(f.publish).toHaveBeenCalledTimes(2);
    } finally {
      f.dispose();
    }
  });

  it("replaces new-chat instructions, keeping the folders the owner chose", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      f.install(
        await template(
          work,
          "Launch",
          workspaceCanvas({ folders: ["/src/app"], canvas: "Old." }),
        ),
      );
      const before = await f.workspaces.get(work);
      expect(before.defaults).toMatchObject({
        instructions: "Old.",
        folders: ["/src/app"],
      });
      await expect(
        f.workspaces.update(
          { id: work, revision: before.revision, instructions: "New." },
          live(),
        ),
      ).rejects.toThrow("defaults changed since that revision");
      const updated = await f.workspaces.update(
        { id: work, revision: before.defaults.revision, instructions: "New." },
        live(),
      );
      expect(updated).toMatchObject({
        outcome: "confirmed",
        defaults: { outcome: "confirmed" },
      });
      expect(updated.groups).toBeUndefined();
      await expect(f.workspaces.get(work)).resolves.toMatchObject({
        name: "Launch",
        defaults: {
          revision: updated.defaults?.revision,
          instructions: "New.",
          folders: ["/src/app"],
        },
      });
    } finally {
      f.dispose();
    }
  });

  it.each([
    [
      "names folders",
      "",
      workspaceCanvas({ folders: ["/etc"], canvas: "Read it." }),
    ],
    [
      "hold part of a folder block",
      "",
      "Read it.\n<!-- /buzz-session-workspace -->",
    ],
    [
      "replaces hand-edited folder instructions",
      workspaceCanvas({ folders: ["/src/app"], canvas: "Old." }).replace(
        "Project folders",
        "My folders",
      ),
      "New.",
    ],
  ])(
    "refuses instructions that %s, sending nothing",
    async (_case, canvas, instructions) => {
      const f = fixture();
      try {
        f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
        if (canvas) f.install(await template(work, "Launch", canvas));
        const { defaults } = await f.workspaces.get(work);
        await expect(
          f.workspaces.update(
            { id: work, revision: defaults.revision, instructions },
            live(),
          ),
        ).rejects.toThrow(
          canvas
            ? "edited this workspace's folder instructions"
            : "cannot name workspace folders",
        );
        if (!canvas)
          await expect(
            f.workspaces.create(
              { id: fresh, name: "Other", instructions },
              live(),
            ),
          ).rejects.toThrow("cannot name workspace folders");
        expect(f.publish).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    },
  );

  it("never resumes another record's unresolved save, or one the owner's window made", async () => {
    const f = fixture();
    try {
      f.install(solo([{ id: work, name: "Launch", defaultTemplateId: "" }]));
      const { revision } = await f.workspaces.get(work);
      await f.session.soloPreferences.ensure();
      f.publish.mockRejectedValueOnce(new Error("Connection lost"));
      await expect(
        f.session.soloPreferences.assign(other, work),
      ).rejects.toThrow();
      const window = f.session.outbox?.snapshot().find((item) => !item.guarded)
        ?.event.id;
      expect(window).toBeDefined();
      await expect(
        f.workspaces.move(
          { chat, workspace: work, revision, resume: window as string },
          live(),
        ),
      ).rejects.toThrow("not an earlier agent save of this record");
      f.publish.mockRejectedValueOnce(new Error("Connection lost"));
      const lost = await f.workspaces.update(
        { id: work, revision: null, instructions: "Plan." },
        live(),
      );
      const defaults = lost.defaults?.operation;
      expect(lost).toMatchObject({ outcome: "unconfirmed" });
      await expect(
        f.workspaces.remove(
          { id: work, revision, resume: defaults as string },
          live(),
        ),
      ).rejects.toThrow("not an earlier agent save of this record");
      // Neither refused resume sent its record again.
      expect(
        f.publish.mock.calls.filter(([event]) => event.id === window),
      ).toHaveLength(1);
      expect(
        f.publish.mock.calls.filter(([event]) => event.id === defaults),
      ).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });
});

describe("owner workspace access", () => {
  it("is offered only with a run lifetime, and to a client only with a checkable turn", async () => {
    const f = fixture();
    try {
      expect(
        createOwnerAccess(
          { pubkey: agent, owner: f.viewer.pubkey },
          () => f.first,
        ).workspaces,
      ).toBeUndefined();
      const handle = {
        pubkey: agent,
        key: agent,
        owner: f.viewer.pubkey,
        ownerAccess: f.access,
      } as unknown as AgentHandle;
      const base = {
        read: vi.fn(),
        memories: async () => ({ entries: [], partial: false }),
      };
      const unchecked = appClient(handle, base);
      expect(unchecked.ownerAccess?.workspaces).toBeUndefined();
      await expect(
        callSessionTool(unchecked, {}, "owner_workspace_create", {
          name: "Launch",
        }),
      ).rejects.toThrow("not available to this agent here");
      let ended = false;
      const client = appClient(handle, {
        ...base,
        check: () => {
          if (ended) throw new Error("The turn ended");
        },
      });
      const answer = JSON.parse(
        String(
          await callSessionTool(client, {}, "owner_workspace_create", {
            workspace: work,
            name: "Launch",
          }),
        ),
      );
      expect(answer).toMatchObject({
        executedAs: { agent, owner: f.viewer.pubkey, community },
        workspace: work,
        outcome: "confirmed",
      });
      ended = true;
      await expect(
        callSessionTool(client, {}, "owner_workspace_remove", {
          workspace: work,
          revision: answer.groups.revision,
        }),
      ).rejects.toThrow("The turn ended");
      expect(f.publish).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });
});
