import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import type { RelayWriter } from "../relay/transport";
import { keypair, signed } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactTemplate,
  type SnapshotRead,
} from "./agent-config-artifacts";
import {
  type LocalSide,
  MIGRATION_STORAGE_KEY,
  MigrationJournal,
  MODE,
  migrate,
  resume,
  revise,
  edited,
  save,
} from "./config-writes";
import { storedBinding } from "./community-config";
import { TeamJournal } from "./team-config";
import { gatedStore, memoryStorage, sharedFiles } from "./test-fakes";

const owner = keypair();
const agent = keypair().pubkey;
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const type = "buzz.agent.instructions";
const subject: Subject = {
  owner: owner.pubkey,
  community: "c",
  subject: agent,
  channel,
  type,
};
const body = (text: string) => JSON.stringify({ version: 1, text });

async function revision(
  content: string,
  op: "create" | "update" | "delete" = "create",
  home = channel,
  d?: string,
) {
  d ??= await artifactD(type, channel);
  const template = artifactTemplate({
    channel: home,
    type,
    d,
    op: op === "delete" ? "update" : op,
    title: "Agent instructions",
    content,
    ...(op === "create" ? {} : { prev: "a".repeat(64) }),
  });
  return signed(owner, {
    ...template,
    tags: template.tags.map((t) => (t[0] === "op" ? ["op", op] : t)),
  });
}

/** A relay holding one head for `d`. `publish` decides each send. */
function relay(
  publish: (event: RelayEvent) => void | Promise<void> = () => {},
) {
  const state = { head: undefined as RelayEvent | undefined, readable: true };
  const sent: RelayEvent[] = [];
  const read: SnapshotRead = async () =>
    state.readable && state.head ? [state.head] : [];
  const writer: RelayWriter = {
    sign: vi.fn(async (template) => signed(owner, template)),
    async publish(event) {
      sent.push(event);
      await publish(event);
      const prev = event.tags.find((t) => t[0] === "prev")?.[1];
      if (!state.head || (prev && prev === state.head.id)) state.head = event;
    },
  };
  return { state, sent, read, writer };
}

async function setup(
  publish?: (event: RelayEvent) => void | Promise<void>,
  storage = memoryStorage(),
) {
  const fake = relay(publish);
  const store = new AgentConfigStore(storage);
  const journal = new MigrationJournal(storage);
  const local = { text: "Be brief.", stripped: 0 };
  const side: LocalSide = {
    subject,
    expected: { channel, type, d: await artifactD(type, channel) },
    title: "Agent instructions",
    content: () => body(local.text),
    strip: () => void local.stripped++,
  };
  const deps = {
    read: fake.read,
    writer: fake.writer,
    store,
    journal,
    maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
    signal: new AbortController().signal,
  };
  return { ...fake, store, journal, local, side, deps, storage };
}

describe("migration journal", () => {
  it("gives every journal status exactly one launch mode", () => {
    expect(Object.keys(MODE).sort()).toEqual(
      [
        "accepted-unavailable",
        "adopted",
        "blocked",
        "confirmed",
        "dispatched",
        "failed",
        "pending",
        "staged",
        "superseded",
        "uncertain",
      ].sort(),
    );
  });

  it("publishes local instructions as a create, installs them and strips the local field", async () => {
    const f = await setup();
    const entry = await migrate(f.deps, f.side);
    expect(entry.status).toBe("confirmed");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.content).toBe(body("Be brief."));
    expect(f.sent[0]?.tags).toContainEqual(["op", "create"]);
    expect(f.store.state(subject)).toMatchObject({ state: "present" });
    expect(f.store.hadVersion(subject)).toBe(true);
    expect(f.local.stripped).toBe(1);
  });

  it.each(["live", "restarted"])(
    "follows a reselected channel, including a %s journal's settled entry for the old one",
    async (mode) => {
      const f = await setup();
      expect((await migrate(f.deps, f.side)).channelId).toBe(channel);
      const other = "0c5f6a52-6a2e-4a8e-9d1f-4b6f1d0e7a11";
      const journal =
        mode === "live" ? f.journal : new MigrationJournal(f.storage);
      const side: LocalSide = {
        ...f.side,
        subject: { ...subject, channel: other },
        expected: { channel: other, type, d: await artifactD(type, other) },
      };
      f.state.head = undefined;
      const entry = await migrate({ ...f.deps, journal }, side);
      expect(entry).toMatchObject({ status: "confirmed", channelId: other });
      expect(f.sent.at(-1)?.tags).toContainEqual(["h", other]);
      expect(
        storedBinding(
          { migration: journal, teams: new TeamJournal(f.storage) },
          owner.pubkey,
          "c",
          agent,
        )?.instructions?.subject.channel,
      ).toBe(other);
    },
  );

  /** A relay with a head per channel, an instructions side whose strip
   * really removes the local text, and a second channel to reselect. */
  async function reselecting() {
    const f = await setup();
    const heads = new Map<string, RelayEvent>();
    const home = (event: RelayEvent) =>
      event.tags.find(([name]) => name === "h")?.[1] ?? "";
    let down = false;
    let blind = false;
    f.writer.publish = async (event) => {
      f.sent.push(event);
      if (down) throw new Error("socket closed");
      const head = heads.get(home(event));
      const prev = event.tags.find((t) => t[0] === "prev")?.[1];
      if (!head || prev === head.id) heads.set(home(event), event);
    };
    const read: SnapshotRead = async (filters) => {
      const head = heads.get(filters[0]?.["#h"]?.[0] ?? "");
      return head && !blind ? [head] : [];
    };
    const side: LocalSide = {
      ...f.side,
      content: () => body(f.local.text),
      strip: () => {
        f.local.text = "";
      },
    };
    const other = "0c5f6a52-6a2e-4a8e-9d1f-4b6f1d0e7a11";
    const moved: LocalSide = {
      ...side,
      subject: { ...subject, channel: other },
      expected: { channel: other, type, d: await artifactD(type, other) },
    };
    const deps = { ...f.deps, read };
    const reopened = (mode: string) =>
      mode === "live"
        ? deps
        : {
            ...deps,
            store: new AgentConfigStore(f.storage),
            journal: new MigrationJournal(f.storage),
          };
    return {
      ...f,
      heads,
      side,
      moved,
      other,
      deps,
      reopened,
      down: (value: boolean) => {
        down = value;
      },
      blind: (value: boolean) => {
        blind = value;
      },
    };
  }

  it.each(["live", "restarted"])(
    "seeds a reselected empty channel from the old one's confirmed copy, not the stripped local field (%s)",
    async (mode) => {
      const f = await reselecting();
      f.local.text = "KEEP THIS";
      expect((await migrate(f.deps, f.side)).status).toBe("confirmed");
      expect(f.local.text).toBe("");
      const entry = await migrate(f.reopened(mode), f.moved);
      expect(entry).toMatchObject({ status: "confirmed", channelId: f.other });
      expect(f.heads.get(f.other)?.content).toBe(body("KEEP THIS"));
    },
  );

  it.each(["live", "restarted"])(
    "resolves a held save on the channel it was signed for after a reselection (%s)",
    async (mode) => {
      const f = await reselecting();
      await migrate(f.deps, f.side);
      f.down(true);
      expect((await save(f.deps, f.side, body("Held"))).status).toBe(
        "uncertain",
      );
      f.down(false);
      const deps = f.reopened(mode);
      await migrate(deps, f.moved);
      const newHead = f.heads.get(f.other);
      // Resolved on its own channel before that seeds this one.
      expect(f.heads.get(channel)?.content).toBe(body("Held"));
      expect(newHead?.content).toBe(body("Held"));
      await resume(deps, f.moved);
      expect(f.heads.get(f.other)).toBe(newHead);
      expect(deps.store.state(f.moved.subject)).toMatchObject({
        state: "present",
        head: newHead,
      });
      expect(deps.store.state(f.moved.subject).problem).toBeUndefined();
      expect(deps.journal.unsaved(f.moved.subject)).toBeUndefined();
    },
  );

  it.each(["live", "restarted"])(
    "keeps a reselection pending until the old channel's held save resolves, then seeds from it (%s)",
    async (mode) => {
      const f = await reselecting();
      f.local.text = "ORIGINAL";
      await migrate(f.deps, f.side);
      f.down(true);
      expect(
        (await save(f.deps, f.side, body("LATEST HELD EDIT"))).status,
      ).toBe("uncertain");
      const pending = await migrate(f.reopened(mode), f.moved);
      expect(pending.status).toBe("pending");
      expect(f.heads.get(f.other)).toBeUndefined();
      f.down(false);
      const deps = f.reopened(mode);
      expect((await resume(deps, f.moved))?.status).toBe("saved");
      expect(f.heads.get(channel)?.content).toBe(body("LATEST HELD EDIT"));
      expect((await migrate(deps, f.moved)).status).toBe("confirmed");
      expect(f.heads.get(f.other)?.content).toBe(body("LATEST HELD EDIT"));
      expect(deps.journal.get(f.moved.subject)?.from).toBeUndefined();
    },
  );

  it.each(["live", "restarted"])(
    "seeds a reselection only once the old channel's head after its held save can be read (%s)",
    async (mode) => {
      const f = await reselecting();
      f.local.text = "ORIGINAL";
      await migrate(f.deps, f.side);
      f.down(true);
      await save(f.deps, f.side, body("LATEST HELD EDIT"));
      await migrate(f.reopened(mode), f.moved);
      f.down(false);
      f.blind(true);
      expect((await resume(f.reopened(mode), f.moved))?.status).toBe(
        "accepted-unavailable",
      );
      expect((await migrate(f.reopened(mode), f.moved)).status).toBe("pending");
      expect(f.heads.get(f.other)).toBeUndefined();
      f.blind(false);
      expect((await migrate(f.reopened(mode), f.moved)).status).toBe(
        "confirmed",
      );
      expect(f.heads.get(f.other)?.content).toBe(body("LATEST HELD EDIT"));
    },
  );

  it.each(["live", "restarted"])(
    "keeps a held save's mark across another reselection while the old head is unreadable (%s)",
    async (mode) => {
      const f = await reselecting();
      f.local.text = "ORIGINAL";
      await migrate(f.deps, f.side);
      f.down(true);
      await save(f.deps, f.side, body("LATEST HELD EDIT"));
      await migrate(f.reopened(mode), f.moved);
      f.down(false);
      f.blind(true);
      expect((await resume(f.reopened(mode), f.moved))?.status).toBe(
        "accepted-unavailable",
      );
      const third = "5d1e7c2a-3b4f-4c6d-8e9f-0a1b2c3d4e5f";
      const again: LocalSide = {
        ...f.moved,
        subject: { ...f.moved.subject, channel: third },
        expected: {
          ...f.moved.expected,
          channel: third,
          d: await artifactD(type, third),
        },
      };
      expect((await migrate(f.reopened(mode), again)).status).toBe("pending");
      expect(f.heads.get(third)).toBeUndefined();
      f.blind(false);
      expect((await migrate(f.reopened(mode), again)).status).toBe("confirmed");
      expect(f.heads.get(third)?.content).toBe(body("LATEST HELD EDIT"));
    },
  );

  it.each(["live", "restarted"])(
    "never overwrites a newer edit already on the reselected channel (%s)",
    async (mode) => {
      const f = await reselecting();
      f.local.text = "ORIGINAL";
      await migrate(f.deps, f.side);
      f.down(true);
      await save(f.deps, f.side, body("LATEST HELD EDIT"));
      await migrate(f.reopened(mode), f.moved);
      const newer = await revision(
        body("NEWER"),
        "create",
        f.other,
        f.moved.expected.d,
      );
      f.heads.set(f.other, newer);
      f.down(false);
      const deps = f.reopened(mode);
      const entry = await migrate(deps, f.moved);
      expect(entry).toMatchObject({
        status: "adopted",
        draft: body("LATEST HELD EDIT"),
      });
      expect(f.heads.get(f.other)).toBe(newer);
    },
  );

  it("publishes missing instructions as an explicit empty revision", async () => {
    const f = await setup();
    f.local.text = "";
    await migrate(f.deps, f.side);
    expect(f.sent[0]?.content).toBe(body(""));
    expect(f.store.instructions(subject)).toEqual({ ok: true, text: "" });
  });

  it("adopts another device's equal head without publishing", async () => {
    const f = await setup();
    f.state.head = await revision(body("Be brief."));
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({ status: "adopted" });
    expect(entry.draft).toBeUndefined();
    expect(f.sent).toHaveLength(0);
    expect(f.local.stripped).toBe(1);
  });

  it("keeps a byte-different local value as a draft when adopting", async () => {
    const f = await setup();
    f.state.head = await revision(body("Be brief. "));
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "adopted",
      draft: body("Be brief."),
    });
    expect(f.local.stripped).toBe(0);
    expect(f.store.instructions(subject)).toEqual({
      ok: true,
      text: "Be brief. ",
    });
  });

  it("blocks on a deleted head and keeps the local value as a draft", async () => {
    const f = await setup();
    f.state.head = await revision("", "delete");
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "blocked",
      draft: body("Be brief."),
    });
    expect(f.store.state(subject).state).toBe("deleted");
    expect(f.store.hadVersion(subject)).toBe(true);
  });

  it("installs an invalid head found by migration as invalid, never present", async () => {
    const f = await setup();
    f.state.head = await revision(body("x"), "create", "another-channel");
    const entry = await migrate(f.deps, f.side);
    expect(entry.status).toBe("blocked");
    expect(f.store.state(subject)).toMatchObject({
      state: "invalid",
      problem: "Artifact home mismatch",
    });
  });

  it("installs an invalid head read after its own publish as invalid, never present", async () => {
    const f = await setup(async () => {
      f.state.head = await revision(body("x"), "update", "another-channel");
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry.status).toBe("superseded");
    expect(f.store.state(subject).state).toBe("invalid");
    expect(f.local.stripped).toBe(0);
  });

  it("resends the identical signed bytes after an uncertain send, across a restart", async () => {
    let lose = true;
    const f = await setup(() => {
      if (lose) throw new Error("socket closed");
    });
    expect((await migrate(f.deps, f.side)).status).toBe("uncertain");
    expect(f.local.stripped).toBe(0);
    lose = false;
    const restarted = {
      ...f.deps,
      store: new AgentConfigStore(f.storage),
      journal: new MigrationJournal(f.storage),
    };
    expect((await migrate(restarted, f.side)).status).toBe("confirmed");
    expect(f.writer.sign).toHaveBeenCalledTimes(1);
    expect(f.sent.map((e) => e.id)).toEqual([f.sent[0]?.id, f.sent[0]?.id]);
    expect(f.storage.getItem(MIGRATION_STORAGE_KEY)).toContain('"confirmed"');
  });

  it("records acceptance with no readable head as accepted-unavailable, never local", async () => {
    const f = await setup();
    f.state.readable = false;
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "accepted-unavailable",
      draft: body("Be brief."),
      eventId: f.sent[0]?.id,
    });
    expect(MODE[entry.status]).toBe("synced");
    expect(f.store.hadVersion(subject)).toBe(true);
    expect(f.local.stripped).toBe(0);
    f.state.readable = true;
    expect((await migrate(f.deps, f.side)).status).toBe("confirmed");
    expect(f.sent).toHaveLength(1);
  });

  it("adopts the winner when its create is refused as identity-taken", async () => {
    const winner = await revision(body("From the other device"));
    const f = await setup(() => {
      f.state.head = winner;
      throw new PublishRejected("refused", "conflict: identity exists");
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "adopted",
      draft: body("Be brief."),
    });
    expect(f.store.state(subject).head?.id).toBe(winner.id);
  });

  it("fails on a definitive refusal and keeps the local value as the launch source", async () => {
    const f = await setup(() => {
      throw new PublishRejected("refused", "invalid: bad tag");
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "failed",
      error: "invalid: bad tag",
    });
    expect(MODE[entry.status]).toBe("migrating");
    expect(f.store.hadVersion(subject)).toBe(false);
    expect(f.local.stripped).toBe(0);
  });

  it("keeps an uncertain send uncertain when its resend is refused", async () => {
    let answer: () => void = () => {
      throw new Error("timeout");
    };
    const f = await setup(() => answer());
    await migrate(f.deps, f.side);
    answer = () => {
      throw new PublishRejected("refused", "conflict: newer head");
    };
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "uncertain",
      draft: body("Be brief."),
    });
    expect(entry.signedEvent?.id).toBe(f.sent[0]?.id);
  });

  it("keeps a local edit made during migration as a draft", async () => {
    const f = await setup(() => {
      f.local.text = "Edited meanwhile";
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "confirmed",
      draft: body("Edited meanwhile"),
    });
    expect(f.local.stripped).toBe(0);
  });
});

describe("journal saves before relay writes", () => {
  /** A journal in agent storage files whose saves wait for `release`, or
   * fail with `fail`. */
  function heldJournal() {
    const files = sharedFiles();
    let release = () => {};
    let fail = (_: Error) => {};
    const hold = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    hold.catch(() => {});
    const journal = new MigrationJournal(files.open(hold));
    return { journal, release, fail };
  }

  it("sends a save only once its held bytes are saved, so a restart resends them", async () => {
    let landed = false;
    const disk = gatedStore(() => landed);
    const held: (string | undefined)[] = [];
    const f = await setup(() => {
      held.push(new MigrationJournal(disk.disk).unsaved(subject)?.event.id);
    });
    const deps = { ...f.deps, journal: new MigrationJournal(disk.store) };
    const saving = save(deps, f.side, body("Held"));
    await vi.waitFor(() => expect(disk.writes).toHaveLength(1));
    expect(f.sent).toHaveLength(0);
    landed = true;
    disk.writes[0]?.land();
    expect((await saving).status).toBe("saved");
    expect(f.sent).toHaveLength(1);
    // What was sent was already saved where a restart reads it.
    expect(held).toEqual([f.sent[0]?.id]);
  });

  it("sends no save and reports the failure when its held bytes can't be saved", async () => {
    const disk = heldJournal();
    const f = await setup();
    const deps = { ...f.deps, journal: disk.journal };
    const saving = save(deps, f.side, body("Held"));
    disk.fail(new Error("disk full"));
    await expect(saving).rejects.toThrow("disk full");
    expect(f.sent).toHaveLength(0);
    expect(disk.journal.unsaved(subject)).toBeUndefined();
  });

  it("migrates only once each journal entry is saved, and sends nothing when one fails", async () => {
    let landed = false;
    const held = gatedStore(() => landed);
    const saved: (string | undefined)[] = [];
    const f = await setup(() => {
      saved.push(new MigrationJournal(held.disk).get(subject)?.signedEvent?.id);
    });
    const migrating = migrate(
      { ...f.deps, journal: new MigrationJournal(held.store) },
      f.side,
    );
    await vi.waitFor(() => expect(held.writes).toHaveLength(1));
    expect(f.sent).toHaveLength(0);
    landed = true;
    held.writes[0]?.land();
    expect((await migrating).status).toBe("confirmed");
    expect(f.sent).toHaveLength(1);
    expect(saved).toEqual([f.sent[0]?.id]);

    const failing = heldJournal();
    const g = await setup();
    const refused = migrate({ ...g.deps, journal: failing.journal }, g.side);
    failing.fail(new Error("disk full"));
    await expect(refused).rejects.toThrow("disk full");
    expect(g.sent).toHaveLength(0);
    expect(failing.journal.get(subject)).toBeUndefined();
  });
});

describe("journal changes are seen only once saved", () => {
  it("keeps a saved change of one subject when another's earlier save fails", async () => {
    const f = await setup();
    const disk = gatedStore();
    const journal = new MigrationJournal(disk.store);
    const deps = { ...f.deps, journal };
    const other: Subject = { ...subject, subject: keypair().pubkey };
    const savingA = save(deps, f.side, body("A"));
    const savingB = save(deps, { ...f.side, subject: other }, body("B"));
    await vi.waitFor(() => expect(disk.writes).toHaveLength(1));
    disk.writes[0]?.fail();
    await expect(savingA).rejects.toThrow("disk full");
    await vi.waitFor(() => expect(disk.writes).toHaveLength(2));
    disk.writes[1]?.land();
    // B's send and its retirement save the rest at once.
    await vi.waitFor(() => expect(disk.writes).toHaveLength(3));
    disk.writes[2]?.land();
    expect((await savingB).status).toBe("saved");
    expect(f.sent.map((event) => event.content)).toEqual([body("B")]);
    const restarted = new MigrationJournal(disk.disk);
    expect(restarted.unsaved(subject)).toBeUndefined();
    expect(restarted.unsaved(other)).toBeUndefined();
  });

  it("resends a replaced run's signed bytes only once they are saved", async () => {
    const disk = gatedStore((value) => !value?.includes('"dispatched"'));
    const saved: (string | undefined)[] = [];
    const f = await setup(() => {
      saved.push(new MigrationJournal(disk.disk).get(subject)?.signedEvent?.id);
    });
    const journal = new MigrationJournal(disk.store);
    const first = new AbortController();
    void migrate({ ...f.deps, journal, signal: first.signal }, f.side).catch(
      () => {},
    );
    await vi.waitFor(() => expect(disk.writes).toHaveLength(1));
    // Replaced, as a reconnect replaces the coordinator, while that saves.
    first.abort();
    const replacement = migrate({ ...f.deps, journal }, f.side);
    disk.writes[0]?.land();
    expect((await replacement).status).toBe("confirmed");
    // Only the bytes saved before any send, never a fresh signature.
    const ids = new Set(f.sent.map((event) => event.id));
    expect(ids.size).toBe(1);
    expect(disk.writes[0]?.value).toContain([...ids][0]);
    // Each send was already saved where a restart reads it.
    expect(saved).toEqual(f.sent.map((event) => event.id));
  });
});

describe("saves as revisions", () => {
  async function synced() {
    const f = await setup();
    await migrate(f.deps, f.side);
    const [first] = f.sent;
    if (!first) throw new Error("migration published nothing");
    return { ...f, first };
  }

  it("saves an edit as an update on the head the editor saw", async () => {
    const f = await synced();
    const result = await save(f.deps, f.side, body("Be kind."));
    expect(result.status).toBe("saved");
    expect(f.sent[1]?.tags).toContainEqual(["op", "update"]);
    expect(f.sent[1]?.tags).toContainEqual(["prev", f.first.id]);
    expect(f.store.instructions(subject)).toEqual({
      ok: true,
      text: "Be kind.",
    });
    expect(f.journal.unsaved(subject)).toBeUndefined();
  });

  it("publishes a first revision as a create when there is no head", async () => {
    const f = await setup();
    expect((await save(f.deps, f.side, body("New"))).status).toBe("saved");
    expect(f.sent[0]?.tags).toContainEqual(["op", "create"]);
    expect(f.store.state(subject).state).toBe("present");
  });

  it("keeps the edit as a draft on conflict and installs the newer head", async () => {
    const f = await synced();
    const newer = await revision(body("Elsewhere"), "update");
    f.writer.publish = async (event) => {
      f.sent.push(event);
      f.state.head = newer;
      throw new PublishRejected("refused", "conflict: stale prev");
    };
    const result = await save(f.deps, f.side, body("Mine"));
    expect(result).toMatchObject({
      status: "conflict",
      head: { id: newer.id },
    });
    expect(f.store.state(subject).head?.id).toBe(newer.id);
    expect(f.journal.unsaved(subject)).toBeUndefined();
  });

  it("installs an invalid head read after a save as invalid, never present", async () => {
    const f = await synced();
    const publish = f.writer.publish;
    f.writer.publish = async (event) => {
      await publish(event, f.deps.signal);
      f.state.head = await revision(body("x"), "update", "another-channel");
    };
    await save(f.deps, f.side, body("Mine"));
    expect(f.store.state(subject)).toMatchObject({
      state: "invalid",
      problem: "Artifact home mismatch",
    });
  });

  it("installs an invalid head read after a save conflict as invalid, never present", async () => {
    const f = await synced();
    const bad = await revision(body("x"), "update", "another-channel");
    f.writer.publish = async () => {
      f.state.head = bad;
      throw new PublishRejected("refused", "conflict: stale prev");
    };
    await save(f.deps, f.side, body("Mine"));
    expect(f.store.state(subject).state).toBe("invalid");
  });

  it("conflicts without sending when the editor opened an older head", async () => {
    const f = await synced();
    expect(
      (await save(f.deps, f.side, body("One"), undefined, f.first.id)).status,
    ).toBe("saved");
    const result = await save(
      f.deps,
      f.side,
      body("Two"),
      undefined,
      f.first.id,
    );
    expect(result).toMatchObject({
      status: "conflict",
      head: { id: f.sent[1]?.id },
    });
    expect(f.sent).toHaveLength(2);
  });

  it("keeps the head's unknown fields and tags on an edit", async () => {
    const f = await synced();
    const d = await artifactD(type, channel);
    const template = artifactTemplate({
      channel,
      type,
      d,
      op: "update",
      prev: f.first.id,
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text: "Old", future: 7 }),
      extra: [["client-tag", "kept"]],
    });
    const newer = await signed(owner, template);
    const publish = f.writer.publish;
    f.writer.publish = async () => {
      f.writer.publish = publish;
      f.state.head = newer;
      throw new PublishRejected("refused", "conflict: stale prev");
    };
    await save(f.deps, f.side, body("Lost"));
    expect(f.store.state(subject).head?.id).toBe(newer.id);
    const result = await save(f.deps, f.side, edited(newer, { text: "New" }));
    expect(result.status).toBe("saved");
    const last = f.sent.at(-1);
    expect(last?.tags).toContainEqual(["client-tag", "kept"]);
    expect(last?.tags).toContainEqual(["prev", newer.id]);
    expect(JSON.parse(last?.content ?? "")).toEqual({
      version: 1,
      text: "New",
      future: 7,
    });
  });

  it("keeps a save held for replay when another save of the subject runs at once", async () => {
    const f = await synced();
    f.writer.publish = async (event) => {
      f.sent.push(event);
      if (event.content === body("Mine")) throw new Error("socket closed");
      throw new PublishRejected("refused", "invalid: bad tag");
    };
    const [mine, other] = await Promise.all([
      save(f.deps, f.side, body("Mine")),
      save(f.deps, f.side, body("Other")),
    ]);
    expect(mine).toMatchObject({ status: "uncertain", retired: false });
    expect(other.status).toBe("uncertain");
    expect(f.journal.unsaved(subject)?.event.content).toBe(body("Mine"));
  });

  it("keeps a new save held when a reconnect resume of an older one runs at once", async () => {
    const f = await synced();
    f.writer.publish = async (event) => {
      f.sent.push(event);
      throw new Error("socket closed");
    };
    expect((await save(f.deps, f.side, body("Mine"))).status).toBe("uncertain");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The reconnect resend is refused late; any other is refused at once, and
    // the newer save stays uncertain.
    let resends = 0;
    f.writer.publish = async (event) => {
      f.sent.push(event);
      if (event.content !== body("Mine")) throw new Error("socket closed");
      if (resends++ === 0) await held;
      throw new PublishRejected("refused", "invalid: bad tag");
    };
    const resumed = resume(f.deps, f.side);
    const newer = save(f.deps, f.side, body("Newer"));
    // The resume's resend is held before the newer save is let through.
    await vi.waitFor(() => expect(resends).toBe(1));
    release();
    await resumed;
    expect(await newer).toMatchObject({ status: "uncertain", retired: false });
    expect(f.journal.unsaved(subject)?.event.content).toBe(body("Newer"));
  });

  it("resends a save's identical bytes after an uncertain send, across a restart", async () => {
    const f = await synced();
    const publish = f.writer.publish;
    f.writer.publish = async (event) => {
      f.sent.push(event);
      throw new Error("socket closed");
    };
    expect((await save(f.deps, f.side, body("Mine"))).status).toBe("uncertain");
    // A later save first resends the held bytes; still unresolved, it stops.
    expect((await save(f.deps, f.side, body("Other"))).status).toBe(
      "uncertain",
    );
    expect(f.sent[2]?.id).toBe(f.sent[1]?.id);
    f.writer.publish = publish;
    const restarted = {
      ...f.deps,
      store: new AgentConfigStore(f.storage),
      journal: new MigrationJournal(f.storage),
    };
    expect((await resume(restarted, f.side))?.status).toBe("saved");
    expect(f.sent[3]?.id).toBe(f.sent[1]?.id);
    expect(restarted.journal.unsaved(subject)).toBeUndefined();
  });
});

it("serializes Save and History revise and recovers the queue after failed signing", async () => {
  const f = await setup();
  await migrate(f.deps, f.side);
  const head = f.store.state(subject).head;
  if (!head) throw new Error("no head");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sign = f.writer.sign;
  let signing = 0;
  f.writer.sign = vi.fn(async (template, signal) => {
    if (++signing === 1) {
      await held;
      throw new Error("sign failed");
    }
    return sign(template, signal);
  });
  const first = save(f.deps, f.side, body("FAIL"));
  const failure = expect(first).rejects.toThrow("sign failed");
  const second = revise(
    f.deps,
    f.side,
    artifactTemplate({
      ...f.side.expected,
      op: "update",
      prev: head.id,
      title: f.side.title,
      content: body("RESTORE"),
    }),
    head.id,
  );
  await vi.waitFor(() => expect(signing).toBe(1));
  release();
  await failure;
  expect((await second).status).toBe("saved");
  expect(f.journal.unsaved(subject)).toBeUndefined();
  expect(f.store.instructions(subject)).toEqual({ ok: true, text: "RESTORE" });
});
