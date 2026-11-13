import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { createOutbox, type OutgoingEvent } from "../../features/relay/outbox";
import type { EventData, ReadFilter } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import {
  loadSubmissions,
  deleteSubmission,
  remindSubmission,
  pullRequest,
  pullRepository,
  submitReview,
} from "./submissions";
import type { SavedReviewConfig } from "./configuration";

const channel = "11111111-1111-4111-8111-111111111111";
const cleanups: (() => void)[] = [];
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: (
        _key: string,
        _options: unknown,
        run: () => Promise<unknown>,
      ) => {
        const task = queue.then(run);
        queue = task.then(
          () => {},
          () => {},
        );
        return task;
      },
    },
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

async function fixture() {
  const owner = keypair(),
    agent = keypair();
  const proof = bytesToHex(
    schnorr.sign(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`nostr:agent-auth:${agent.pubkey}:`),
        ),
      ),
      owner.secret,
    ),
  );
  let profile = signed(agent, {
    kind: 0,
    content: "{}",
    tags: [["auth", owner.pubkey, "", proof]],
  });
  const heads = new Map<string, EventData>();
  const messages = new Map<string, EventData>();
  let journal: readonly OutgoingEvent[] = [];
  const publish = vi.fn(async (event: EventData) => {
    messages.set(event.id, event);
  });
  const box = createOutbox(
    owner.pubkey,
    { sign: async (template) => signed(owner, template), publish },
    {
      load: () => structuredClone(journal),
      save: (next) => {
        journal = structuredClone(next);
      },
    },
  );
  cleanups.push(box.dispose);
  const artifactPublish = vi.fn(async (event: EventData) => {
    const id = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
    const previous = heads.get(id);
    if (event.tags.find((tag) => tag[0] === "prev")?.[1] !== previous?.id)
      throw new Error("stale revision");
    heads.set(id, event);
    return event.id;
  });
  const session = {
    viewer: owner.pubkey,
    scope: `https://example.org:${owner.pubkey}`,
    outbox: box.outbox,
    agentChoices: {
      refresh: async () => {},
      snapshot: () => ({
        archives: { status: "ready" },
        selectable: [{ pubkey: agent.pubkey }],
      }),
    },
    snapshotRead: vi.fn(async (filters: ReadFilter[]) => {
      const filter = filters[0];
      if (!filter) throw new Error("Missing filter");
      if (filter.artifact && filter.consistency)
        throw new Error("unsupported artifact predicate");
      if (filter.kinds?.includes(0)) return [profile];
      if (filter.kinds?.includes(9))
        return [...messages.values()].filter(
          (event) =>
            (!filter.ids || filter.ids.includes(event.id)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            Object.entries(filter).every(
              ([key, values]) =>
                !key.startsWith("#") ||
                (values as string[]).some((value) =>
                  event.tags.some(
                    (tag) => tag[0] === key.slice(1) && tag[1] === value,
                  ),
                ),
            ),
        );
      return [...heads.values()].filter(
        (event) =>
          !filter["#d"] ||
          filter["#d"].includes(
            event.tags.find((tag) => tag[0] === "d")?.[1] ?? "",
          ),
      );
    }),
    configArtifactWriter: {
      sign: async (template: Parameters<typeof signed>[1]) =>
        signed(owner, template),
      publish: artifactPublish,
    },
  } as unknown as RelaySession;
  const config: SavedReviewConfig = {
    revision: "c".repeat(64),
    artifactId: "config",
    config: {
      version: 1,
      repository: "example-org/project",
      reminderMinutes: 15,
      lanes: [
        {
          id: "backend",
          name: "Backend",
          instructions: "Check authorization and tests.",
          reviewers: [agent.pubkey],
        },
        {
          id: "ui",
          name: "UI",
          instructions: "Check keyboard access.",
          reviewers: [agent.pubkey],
        },
      ],
    },
  };
  const run = (
    input = "123",
    signal = new AbortController().signal,
    resume = false,
  ) =>
    submitReview(
      session,
      channel,
      config,
      input,
      [agent.pubkey, agent.pubkey],
      signal,
      () => {},
      resume,
    );
  return {
    owner,
    agent,
    profile,
    heads,
    messages,
    session,
    config,
    run,
    publish,
    artifactPublish,
    box,
    loseJournal() {
      box.dispose();
      journal = [];
      const replacement = createOutbox(
        owner.pubkey,
        { sign: async (template) => signed(owner, template), publish },
        { load: () => [], save: () => {} },
      );
      cleanups.push(replacement.dispose);
      (session as { outbox: typeof replacement.outbox }).outbox =
        replacement.outbox;
    },
    changeOwner() {
      profile = signed(agent, { kind: 0, content: "{}", tags: [] });
    },
  };
}

it("validates canonical PR input and refuses other repositories or non-PR URLs", () => {
  expect(pullRequest("#42", "example-org/project")).toBe(42);
  expect(
    pullRequest(
      "https://github.com/Example-Org/Project/pull/42/",
      "example-org/project",
    ),
  ).toBe(42);
  for (const input of [
    "0",
    "1.5",
    "9007199254740992",
    "https://github.com/other/project/pull/1",
    "https://github.com/example-org/project/issues/1",
    "https://user@github.com/example-org/project/pull/1",
    "https://github.com/example-org/project/pull/1?x=2",
  ])
    expect(() => pullRequest(input, "example-org/project")).toThrow();
});

it("saves the instruction snapshot and creates only distinct lane threads, without an overview", async () => {
  const f = await fixture();
  const record = await f.run();
  expect(record.value.threads.every((thread) => thread.delivered)).toBe(true);
  expect(f.messages.size).toBe(2);
  const messages = [...f.messages.values()];
  expect(record.value.version).toBe(2);
  expect(record.value.submittedAt).toBeGreaterThan(0);
  for (const [index, message] of messages.entries()) {
    expect(message.tags).toContainEqual(["p", f.agent.pubkey]);
    expect(message.tags.some((tag) => tag[0] === "e")).toBe(false);
    expect(message.content).toContain(
      f.config.config.lanes[index]?.instructions,
    );
    expect(message.content).not.toContain("Overview:");
  }
  expect(
    (await loadSubmissions(f.session, channel, new AbortController().signal))
      .rows[0],
  ).toEqual({
    ...record,
    reviewStates: ["need_review", "need_review"],
    reviewReports: [],
  });
  await f.run();
  expect(f.publish).toHaveBeenCalledTimes(2);
});

it("serializes simultaneous submissions of the same PR", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.run(), f.run()]);
  expect(first.value.threads).toEqual(second.value.threads);
  expect(f.messages.size).toBe(2);
});

it("retries the same signed event after ambiguous publication without duplicating threads", async () => {
  const f = await fixture();
  f.publish.mockImplementationOnce(async (event) => {
    f.messages.set(event.id, event);
    throw new Error("Receipt lost");
  });
  await expect(f.run()).rejects.toThrow();
  const firstId = f.publish.mock.calls[0]?.[0].id;
  await f.run("123", undefined, true);
  expect(f.publish.mock.calls[1]?.[0].id).toBe(firstId);
  expect(f.messages.size).toBe(2);
});

it("recovers a send whose artifact update failed before its ID was saved", async () => {
  const f = await fixture();
  const original = f.artifactPublish.getMockImplementation();
  if (!original) throw new Error("Missing fixture publisher");
  f.artifactPublish
    .mockImplementationOnce(original)
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error("save interrupted"));
  await expect(f.run()).rejects.toThrow("save interrupted");
  await f.run("123", undefined, true);
  expect(f.messages.size).toBe(2);
  expect(f.publish).toHaveBeenCalledTimes(2);
});

it("does not take over incomplete delivery after browser recovery storage is lost", async () => {
  const f = await fixture();
  f.publish.mockRejectedValueOnce(new Error("offline"));
  await expect(f.run()).rejects.toThrow();
  localStorage.setItem(
    `buzz.review.device:${f.session.scope}`,
    crypto.randomUUID(),
  );
  await expect(f.run("123", undefined, true)).rejects.toThrow(
    "original browser profile",
  );
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it("refuses unattested reviewers before saving or sending", async () => {
  const f = await fixture();
  f.changeOwner();
  await expect(f.run()).rejects.toThrow("verified ownership");
  expect(f.heads.size).toBe(0);
  expect(f.publish).not.toHaveBeenCalled();
});

it("stops on cancellation and resumes only the saved message IDs", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.publish.mockImplementationOnce(async (event) => {
    f.messages.set(event.id, event);
    controller.abort();
  });
  await expect(f.run("123", controller.signal)).rejects.toThrow();
  const firstId = f.publish.mock.calls[0]?.[0].id;
  await f.run("123", undefined, true);
  expect(f.messages.has(firstId ?? "")).toBe(true);
  expect(f.messages.size).toBe(2);
});

it("opens an existing incomplete record without sending a changed preview", async () => {
  const f = await fixture();
  f.publish.mockRejectedValueOnce(new Error("offline"));
  await expect(f.run()).rejects.toThrow();
  const changed = {
    ...f.config,
    config: {
      ...f.config.config,
      lanes: f.config.config.lanes.map((lane) => ({
        ...lane,
        instructions: "New instructions",
      })),
    },
  };
  const record = await submitReview(
    f.session,
    channel,
    changed,
    "123",
    [f.agent.pubkey, f.agent.pubkey],
    new AbortController().signal,
    () => {},
  );
  expect(record.value.config.lanes[0]?.instructions).toBe(
    "Check authorization and tests.",
  );
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it("fails closed when a sent message loses its journal before its ID was saved", async () => {
  const f = await fixture();
  const original = f.artifactPublish.getMockImplementation();
  if (!original) throw new Error("Missing fixture publisher");
  f.artifactPublish
    .mockImplementationOnce(original)
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error("save interrupted"));
  await expect(f.run()).rejects.toThrow("save interrupted");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  f.loseJournal();
  await expect(f.run("123", undefined, true)).rejects.toThrow(
    "recovery journal is missing",
  );
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it("can resume after a proven rejection before enqueue", async () => {
  const f = await fixture();
  const send = vi.fn(f.box.outbox.send).mockImplementationOnce(() => {
    throw new Error("Outbox full");
  });
  (f.session as { outbox: typeof f.box.outbox }).outbox = {
    ...f.box.outbox,
    send,
  };
  await expect(f.run()).rejects.toThrow("Outbox full");
  const saved = (
    await loadSubmissions(f.session, channel, new AbortController().signal)
  ).rows[0];
  expect(saved?.value.threads[0]).toEqual({ request: expect.any(String) });
  await f.run("123", undefined, true);
  expect(f.messages.size).toBe(2);
});

it("routes to every matching lane and refuses to send when no lane matches", async () => {
  const f = await fixture();
  const facts = {
    repository: "example-org/project",
    pr: 124,
    title: "UI fix",
    labels: [],
    changedFiles: 1,
    paths: ["ui/form.tsx"],
    head: "a".repeat(40),
    base: "b".repeat(40),
  };
  const saved: SavedReviewConfig = {
    ...f.config,
    config: {
      ...f.config.config,
      lanes: f.config.config.lanes.map((lane) => ({
        ...lane,
        routing: {
          mode: "all",
          rules: [
            {
              id: lane.id,
              field: "path",
              operator: "matches",
              value: `${lane.id}/**`,
            },
          ],
        },
      })),
    },
  };
  await expect(
    submitReview(
      f.session,
      channel,
      saved,
      "124",
      [f.agent.pubkey, f.agent.pubkey],
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("Load PR details");
  expect(f.heads.size).toBe(0);
  const record = await submitReview(
    f.session,
    channel,
    saved,
    "124",
    [f.agent.pubkey, f.agent.pubkey],
    new AbortController().signal,
    () => {},
    false,
    facts,
  );
  expect(record.value.config.lanes.map((lane) => lane.name)).toEqual(["UI"]);
  expect(f.messages.size).toBe(1);
  expect([...f.messages.values()][0]?.content).toContain(
    "Check keyboard access.",
  );
  await expect(
    submitReview(
      f.session,
      channel,
      saved,
      "125",
      [f.agent.pubkey, f.agent.pubkey],
      new AbortController().signal,
      () => {},
      false,
      { ...facts, pr: 125, paths: ["docs/a.md"] },
    ),
  ).rejects.toThrow("No lanes match");
  expect(f.messages.size).toBe(1);
});

it("retains old overview and lane IDs when reloading and resuming a version-one record", async () => {
  const f = await fixture();
  const record = await f.run();
  const head = f.heads.get(record.artifactId);
  if (!head) throw new Error("Missing fixture head");
  const overview = signed(f.owner, {
    kind: 9,
    content: "Earlier overview",
    tags: [["h", channel]],
  });
  f.messages.set(overview.id, overview);
  const value = {
    ...record.value,
    version: 1,
    threads: [
      { id: overview.id, delivered: true },
      ...record.value.threads.map((thread) => ({ id: thread.id })),
    ],
  };
  f.heads.set(
    record.artifactId,
    signed(f.owner, {
      kind: head.kind,
      content: JSON.stringify(value),
      tags: head.tags,
    }),
  );
  const resumed = await f.run("123", undefined, true);
  expect(resumed.value.version).toBe(1);
  expect(resumed.value.threads.map((thread) => thread.id)).toEqual(
    value.threads.map((thread) => thread.id),
  );
  expect(resumed.value.threads.every((thread) => thread.delivered)).toBe(true);
  expect(f.publish).toHaveBeenCalledTimes(2);
});

it("infers a canonical repository only from a valid full PR URL", () => {
  expect(
    pullRepository(" https://github.com/Example-Org/Project/pull/12/ "),
  ).toBe("example-org/project");
  for (const input of [
    "12",
    "https://example.org/a/b/pull/12",
    "https://github.com/a/b/pull/0",
    "https://github.com/a/b/pull/9007199254740992",
    "https://user@github.com/a/b/pull/12",
  ])
    expect(() => pullRepository(input)).toThrow();
});

it("explicit resubmission resets review requests in existing threads without GitHub reads", async () => {
  const test = await fixture();
  const first = await test.run();
  const writes = test.artifactPublish.mock.calls.length;
  const facts = vi.fn(async () => {
    throw new Error("GitHub unavailable");
  });
  const existing = vi.fn();
  const again = () =>
    submitReview(
      test.session,
      channel,
      test.config,
      "123",
      [test.agent.pubkey, test.agent.pubkey],
      new AbortController().signal,
      () => {},
      true,
      facts,
      existing,
    );
  const result = await again();
  expect(result.value.threads.map((thread) => thread.id)).toEqual(
    first.value.threads.map((thread) => thread.id),
  );
  expect(result.value.threads[0]?.request).not.toBe(
    first.value.threads[0]?.request,
  );
  expect(test.artifactPublish).toHaveBeenCalledTimes(writes + 2);
  expect(facts).not.toHaveBeenCalled();
  expect(existing).toHaveBeenCalledOnce();
  const replies = [...test.messages.values()].filter((event) =>
    event.tags.some((tag) => tag[0] === "e"),
  );
  expect(replies).toHaveLength(2);
  for (const [i, reply] of replies.entries()) {
    expect(reply.tags).toContainEqual([
      "e",
      first.value.threads[i]?.id,
      "",
      "reply",
    ]);
    expect(reply.tags).toContainEqual(["p", test.agent.pubkey]);
    expect(reply.tags.some((tag) => tag[0] === "subject")).toBe(false);
    expect(reply.content).toContain("**Review requested again:**");
  }
  await again();
  expect(test.publish).toHaveBeenCalledTimes(6);
});

it("revalidates ownership before notifying and retains existing threads on refusal", async () => {
  const test = await fixture();
  await test.run();
  test.changeOwner();
  await expect(
    submitReview(
      test.session,
      channel,
      test.config,
      "123",
      [test.agent.pubkey, test.agent.pubkey],
      new AbortController().signal,
      () => {},
      true,
      undefined,
      () => {},
    ),
  ).rejects.toThrow("verified ownership");
  expect(test.publish).toHaveBeenCalledTimes(2);
});

it("routes fresh facts inside Submit and refuses no-match before writing", async () => {
  const test = await fixture();
  const config = {
    ...test.config,
    config: {
      ...test.config.config,
      lanes: test.config.config.lanes.map((lane) => ({
        ...lane,
        routing: {
          mode: "all" as const,
          rules: [
            {
              id: "label",
              field: "label" as const,
              operator: "has" as const,
              value: "security",
            },
          ],
        },
      })),
    },
  };
  const facts = vi.fn(async () => ({
    repository: "example-org/project",
    pr: 123,
    title: "UI change",
    labels: [],
    changedFiles: 1,
    paths: ["ui.tsx"],
    head: "a".repeat(40),
    base: "b".repeat(40),
  }));
  await expect(
    submitReview(
      test.session,
      channel,
      config,
      "123",
      [test.agent.pubkey, test.agent.pubkey],
      new AbortController().signal,
      () => {},
      true,
      facts,
      () => {},
    ),
  ).rejects.toThrow("No lanes match");
  expect(facts).toHaveBeenCalledOnce();
  expect(test.artifactPublish).not.toHaveBeenCalled();
  expect(test.publish).not.toHaveBeenCalled();
});

it("retries a partially delivered notification batch with the same message identities", async () => {
  const test = await fixture();
  const first = await test.run();
  test.publish.mockImplementationOnce(async (event) => {
    test.messages.set(event.id, event);
  });
  test.publish.mockRejectedValueOnce(new Error("notification offline"));
  const again = () =>
    submitReview(
      test.session,
      channel,
      test.config,
      "123",
      [test.agent.pubkey, test.agent.pubkey],
      new AbortController().signal,
      () => {},
      true,
      undefined,
      () => {},
    );
  await expect(again()).rejects.toThrow("notification offline");
  const attempted = test.publish.mock.calls.slice(2).map(([event]) => event.id);
  await again();
  expect(test.publish.mock.calls.slice(2).map(([event]) => event.id)).toEqual([
    ...attempted,
    attempted[1],
  ]);
  expect(
    [...test.messages.values()].filter((event) =>
      event.tags.some((tag) => tag[0] === "subject"),
    ),
  ).toHaveLength(2);
  expect((await test.run()).value.threads.map((thread) => thread.id)).toEqual(
    first.value.threads.map((thread) => thread.id),
  );
});

it("deletes from the shared list and starts fresh threads using current routing after reload", async () => {
  const f = await fixture();
  const record = await f.run();
  await deleteSubmission(
    f.session,
    channel,
    record,
    new AbortController().signal,
  );
  expect(
    (await loadSubmissions(f.session, channel, new AbortController().signal))
      .rows,
  ).toEqual([]);
  expect(f.messages.size).toBe(2);
  f.loseJournal();
  const existing = vi.fn();
  const facts = vi.fn(async () => ({
    repository: "example-org/project",
    pr: 123,
    title: "Fresh review",
    labels: [],
    changedFiles: 1,
    paths: ["backend.ts"],
    head: "a".repeat(40),
    base: "b".repeat(40),
  }));
  const lane = f.config.config.lanes[0];
  if (!lane) throw new Error("Missing fixture lane");
  const config = {
    ...f.config,
    config: {
      ...f.config.config,
      lanes: [
        {
          ...lane,
          instructions: "New review instructions",
        },
      ],
    },
  };
  const restored = await submitReview(
    f.session,
    channel,
    config,
    "123",
    [f.agent.pubkey],
    new AbortController().signal,
    () => {},
    true,
    facts,
    existing,
  );
  expect(restored.value.deleted).toBeUndefined();
  expect(restored.value.version).toBe(3);
  expect(restored.value.threads).toHaveLength(1);
  expect(record.value.threads.map((t) => t.id)).not.toContain(
    restored.value.threads[0]?.id,
  );
  expect(facts).toHaveBeenCalledOnce();
  expect(existing).not.toHaveBeenCalled();
  expect(f.messages.size).toBe(3);
  const message = f.messages.get(restored.value.threads[0]?.id ?? "");
  expect(message?.content).toContain("New review instructions");
  expect(message?.tags.some((t) => t[0] === "e")).toBe(false);
  expect(
    (await loadSubmissions(f.session, channel, new AbortController().signal))
      .rows,
  ).toHaveLength(1);
});

it("rejects foreign submitters and stale deletion without changing the saved list", async () => {
  const f = await fixture();
  const record = await f.run();
  await expect(
    deleteSubmission(
      { ...f.session, viewer: keypair().pubkey },
      channel,
      record,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Only the original submitter");
  await expect(
    deleteSubmission(
      f.session,
      channel,
      { ...record, revision: "0".repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow("changed");
  expect(
    (await loadSubmissions(f.session, channel, new AbortController().signal))
      .rows,
  ).toHaveLength(1);
});

it("isolates a fresh review from old receipts and resumes its own interrupted delivery", async () => {
  const f = await fixture();
  const original = f.session.outbox;
  if (!original) throw new Error("Missing fixture outbox");
  Object.assign(f.session, {
    outbox: { ...original, acknowledge: async () => {} },
  });
  const first = await f.run();
  await deleteSubmission(
    f.session,
    channel,
    first,
    new AbortController().signal,
  );
  Object.assign(f.session, { outbox: original });
  f.publish.mockRejectedValueOnce(new Error("offline"));
  await expect(f.run("123", undefined, true)).rejects.toThrow();
  const incomplete = (
    await loadSubmissions(f.session, channel, new AbortController().signal)
  ).rows[0];
  if (!incomplete) throw new Error("Missing incomplete submission");
  expect(incomplete.value.threads[0]?.id).not.toBe(first.value.threads[0]?.id);
  const resumed = await f.run("123", undefined, true);
  expect(resumed.value.generation).toBe(incomplete.value.generation);
  expect(resumed.value.threads[0]?.id).toBe(incomplete.value.threads[0]?.id);
  expect(resumed.value.threads.every((t) => t.delivered)).toBe(true);
  expect(f.messages.size).toBe(4);
  await deleteSubmission(
    f.session,
    channel,
    resumed,
    new AbortController().signal,
  );
  const next = await f.run("123", undefined, true);
  expect(next.value.generation).not.toBe(resumed.value.generation);
  expect(f.messages.size).toBe(6);
});

it("does not send fresh threads when replacing a deleted record loses its revision race", async () => {
  const f = await fixture();
  const first = await f.run();
  await deleteSubmission(
    f.session,
    channel,
    first,
    new AbortController().signal,
  );
  f.artifactPublish.mockRejectedValueOnce(new Error("stale revision"));
  await expect(f.run("123", undefined, true)).rejects.toThrow("stale revision");
  expect(f.messages.size).toBe(2);
  expect(
    (await loadSubmissions(f.session, channel, new AbortController().signal))
      .rows,
  ).toEqual([]);
});

it("refuses a foreign submitter replacing a deleted record", async () => {
  const f = await fixture();
  const first = await f.run();
  await deleteSubmission(
    f.session,
    channel,
    first,
    new AbortController().signal,
  );
  await expect(
    submitReview(
      { ...f.session, viewer: keypair().pubkey },
      channel,
      f.config,
      "123",
      [f.agent.pubkey, f.agent.pubkey],
      new AbortController().signal,
      () => {},
      true,
    ),
  ).rejects.toThrow("Only the original submitter");
  expect(f.messages.size).toBe(2);
});

it("reminds saved reviewers and resets requests without replacing threads", async () => {
  const test = await fixture();
  const first = await test.run();
  const writes = test.artifactPublish.mock.calls.length;
  const updated = await remindSubmission(
    test.session,
    channel,
    first,
    new AbortController().signal,
    async () => "Open",
  );
  const replies = [...test.messages.values()].filter((event) =>
    event.tags.some((tag) => tag[0] === "e"),
  );
  expect(replies).toHaveLength(2);
  for (const [index, reply] of replies.entries()) {
    expect(reply.tags).toContainEqual([
      "e",
      first.value.threads[index]?.id,
      "",
      "reply",
    ]);
    expect(reply.tags).toContainEqual(["p", test.agent.pubkey]);
    expect(reply.content).toContain("Review reminder.");
  }
  expect(test.artifactPublish).toHaveBeenCalledTimes(writes + 2);
  await deleteSubmission(
    test.session,
    channel,
    updated,
    new AbortController().signal,
  );
  await expect(
    remindSubmission(
      test.session,
      channel,
      first,
      new AbortController().signal,
      async () => "Open",
    ),
  ).rejects.toThrow("Submission changed");
  expect(test.publish).toHaveBeenCalledTimes(4);
});

it("retries interrupted reminder batches without duplicating accepted replies", async () => {
  const test = await fixture();
  const first = await test.run();
  test.publish
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("offline"));
  await expect(
    remindSubmission(
      test.session,
      channel,
      first,
      new AbortController().signal,
      async () => "Open",
      "",
      undefined,
      "Original note",
    ),
  ).rejects.toThrow("offline");
  const reloaded = (
    await loadSubmissions(test.session, channel, new AbortController().signal)
  ).rows[0];
  if (!reloaded) throw new Error("Missing reloaded submission");
  await remindSubmission(
    test.session,
    channel,
    reloaded,
    new AbortController().signal,
    async () => "Open",
    "",
    undefined,
    "Do not replace the saved note",
  );
  const replies = [...test.messages.values()].filter((event) =>
    event.tags.some((tag) => tag[0] === "e"),
  );
  // The first successful publish was stubbed; compare signed event IDs instead.
  const sent = test.publish.mock.calls.slice(2).map(([event]) => event);
  expect(sent).toHaveLength(3);
  expect(sent.every((event) => event.content.includes("Original note"))).toBe(
    true,
  );
  expect(
    sent.every(
      (event) => !event.content.includes("Do not replace the saved note"),
    ),
  ).toBe(true);
  expect(sent[1]?.id).toBe(sent[2]?.id);
  expect(sent[0]?.id).not.toBe(sent[1]?.id);
  expect(replies).toHaveLength(1);
});

it("refuses reminders for incomplete delivery and other submitters", async () => {
  const test = await fixture();
  test.publish.mockRejectedValueOnce(new Error("offline"));
  await expect(test.run()).rejects.toThrow("offline");
  const { rows } = await loadSubmissions(
    test.session,
    channel,
    new AbortController().signal,
  );
  const row = rows[0];
  if (!row) throw new Error("Missing fixture submission");
  await expect(
    remindSubmission(
      test.session,
      channel,
      row,
      new AbortController().signal,
      async () => "Open",
    ),
  ).rejects.toThrow("Delivery is incomplete");
  await expect(
    remindSubmission(
      { ...test.session, viewer: test.agent.pubkey },
      channel,
      row,
      new AbortController().signal,
      async () => "Open",
    ),
  ).rejects.toThrow("Only the original submitter");
  expect(test.publish).toHaveBeenCalledTimes(1);
});

it.each(["Closed", "Merged"] as const)(
  "does not remind a PR that is now %s",
  async (status) => {
    const test = await fixture();
    const row = await test.run();
    const readStatus = vi.fn(async () => status);
    await expect(
      remindSubmission(
        test.session,
        channel,
        row,
        new AbortController().signal,
        readStatus,
      ),
    ).rejects.toThrow("closed or merged");
    expect(readStatus).toHaveBeenCalledWith(
      "example-org/project",
      123,
      expect.any(AbortSignal),
    );
    expect(test.publish).toHaveBeenCalledTimes(2);
  },
);

it("sends nothing when GitHub status cannot be confirmed", async () => {
  const test = await fixture();
  const row = await test.run();
  await expect(
    remindSubmission(
      test.session,
      channel,
      row,
      new AbortController().signal,
      async () => {
        throw new Error("GitHub unavailable");
      },
    ),
  ).rejects.toThrow("GitHub unavailable");
  expect(test.publish).toHaveBeenCalledTimes(2);
});

it("completes the status-only review loop, resets on Remind, and ignores other reviewers", async () => {
  const { callTool, TOOLS } = await import("../../buzz-mcp/tools");
  const test = await fixture();
  const first = await test.run();
  const roots = first.value.threads.map((thread) => thread.id ?? "");
  const snapshotRead = test.session.snapshotRead;
  if (!snapshotRead) throw new Error("Missing reader");
  const schema = TOOLS.find(
    (tool) => tool.name === "pr_review_status_update",
  )?.inputSchema;
  expect(schema).toMatchObject({
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: {
        enum: ["reviewing", "request_changes", "lgtm_not_approved", "approved"],
      },
    },
  });
  expect(Object.keys(schema?.properties ?? {})).toEqual(["status"]);
  const query = vi.fn(
    async (filters: readonly import("../../buzz-mcp/client").Filter[]) => {
      const filter = filters[0];
      if (!filter) throw new Error("Missing filter");
      const source = filter.artifact
        ? [...test.heads.values()]
        : [...test.messages.values()];
      return source.filter((event) =>
        Object.entries(filter).every(([key, value]) => {
          if (key === "kinds") return (value as number[]).includes(event.kind);
          if (key === "authors")
            return (value as string[]).includes(event.pubkey);
          if (key.startsWith("#"))
            return event.tags.some(
              (tag) =>
                tag[0] === key.slice(1) &&
                (value as string[]).includes(tag[1] ?? ""),
            );
          return true;
        }),
      );
    },
  );
  const publish = vi.fn(
    async (template: import("../../buzz-mcp/client").Template) => {
      const event = signed(test.agent, {
        ...template,
        tags: template.tags.map((tag) => [...tag]),
      });
      test.messages.set(event.id, event);
      return event;
    },
  );
  const client = {
    pubkey: test.agent.pubkey,
    key: test.agent.pubkey,
    query,
    publish,
  } as unknown as import("../../buzz-mcp/client").BuzzClient;
  const report = (index: number, status: string, extra = {}) =>
    callTool(
      client,
      {
        review: { channel, root: roots[index] ?? "" },
      },
      "pr_review_status_update",
      { status, ...extra },
    );
  // The dashboard reads the exact signed events published through the tool.
  vi.mocked(snapshotRead).mockImplementation(
    async (filters) =>
      query(filters) as Promise<
        import("../../features/relay/events").RelayEvent[]
      >,
  );
  await expect(report(0, "waiting")).rejects.toThrow("Only status");
  await expect(report(0, "lgtm_not_approved", { pr: 999 })).rejects.toThrow(
    "Only status",
  );
  await expect(
    callTool(client, {}, "pr_review_status_update", {
      status: "lgtm_not_approved",
    }),
  ).rejects.toThrow("host has not supplied");
  await expect(
    callTool(
      { ...client, pubkey: "f".repeat(64) },
      { review: { channel, root: roots[0] ?? "" } },
      "pr_review_status_update",
      { status: "lgtm_not_approved" },
    ),
  ).rejects.toThrow("no unique active review");
  expect(publish).not.toHaveBeenCalled();
  await report(0, "reviewing");
  await report(0, "reviewing");
  expect(publish).toHaveBeenCalledTimes(1);
  await expect(report(0, "approved")).rejects.toThrow(
    "Automatic approval is disabled",
  );
  expect(
    (await loadSubmissions(test.session, channel, new AbortController().signal))
      .rows[0]?.reviewStates,
  ).toEqual(["reviewing", "need_review"]);
  expect(
    (await loadSubmissions(test.session, channel, new AbortController().signal))
      .rows[0]?.lastReviewedAt,
  ).toBeUndefined();
  await report(0, "request_changes");
  await report(1, "reviewing");
  await report(1, "lgtm_not_approved");
  const read = () =>
    loadSubmissions(test.session, channel, new AbortController().signal);
  expect((await read()).rows[0]?.reviewStates).toEqual([
    "request_changes",
    "lgtm_not_approved",
  ]);
  await report(0, "request_changes");
  expect(publish).toHaveBeenCalledTimes(4);
  await report(0, "lgtm_not_approved");
  expect((await read()).rows[0]?.reviewStates).toEqual([
    "lgtm_not_approved",
    "lgtm_not_approved",
  ]);
  vi.mocked(snapshotRead).mockImplementation(async (filters) =>
    filters[0]?.kinds?.includes(0)
      ? [test.profile]
      : (query(filters) as Promise<
          import("../../features/relay/events").RelayEvent[]
        >),
  );
  const lastReviewedAt = (await read()).rows[0]?.lastReviewedAt;
  expect(lastReviewedAt).toBeGreaterThan(0);
  const reset = await remindSubmission(
    test.session,
    channel,
    first,
    new AbortController().signal,
    async () => "Open",
    "Tool-owned instructions",
    undefined,
    "Please have another look at keyboard access.",
  );
  expect(reset.value.submittedAt).toBe(first.value.submittedAt);
  expect((await read()).rows[0]?.lastReviewedAt).toBe(lastReviewedAt);
  expect(reset.value.threads.map((thread) => thread.id)).toEqual(
    first.value.threads.map((thread) => thread.id),
  );
  expect((await read()).rows[0]?.reviewStates).toEqual([
    "need_review",
    "need_review",
  ]);
  for (const status of ["request_changes", "lgtm_not_approved"]) {
    await expect(report(0, status)).rejects.toThrow("Set reviewing first");
    expect((await read()).rows[0]?.reviewStates).toEqual([
      "need_review",
      "need_review",
    ]);
  }
  const corrections = [...test.messages.values()].filter((event) =>
    event.tags.some(
      (tag) => tag[0] === "t" && tag[1] === "buzz.review.sequence-correction",
    ),
  );
  expect(corrections).toHaveLength(1);
  expect(corrections[0]?.tags).toContainEqual(["p", test.agent.pubkey]);
  await report(0, "reviewing");
  await report(0, "lgtm_not_approved");
  expect((await read()).rows[0]?.reviewStates).toEqual([
    "lgtm_not_approved",
    "need_review",
  ]);
  const reminder = [...test.messages.values()].find((event) =>
    event.content.includes("Review reminder."),
  );
  if (!reminder) throw new Error("Missing reminder");
  expect(reminder.content).toContain("Tool-owned instructions");
  expect(reminder?.content).toContain(
    "**Your reminder message**\n\n> Please have another look at keyboard access.",
  );
  expect(reminder?.content).toContain("**Lane instructions**");
  expect(reminder.content.indexOf("**Your reminder message**")).toBeLessThan(
    reminder.content.indexOf("**Lane instructions**"),
  );
  expect(reminder.content.indexOf("**Lane instructions**")).toBeLessThan(
    reminder.content.indexOf("**Required steps**"),
  );
  expect(reminder?.content).toContain(
    "Please have another look at keyboard access.",
  );
  expect(reminder?.content).toContain(
    "**AUTOMATIC APPROVAL: OFF — DO NOT APPROVE THIS PR ON GITHUB.**",
  );
  await deleteSubmission(
    test.session,
    channel,
    reset,
    new AbortController().signal,
  );
  await expect(report(0, "lgtm_not_approved")).rejects.toThrow(
    "no unique active review",
  );
});

it("refuses a capped report snapshot instead of showing missing reports as needs review", async () => {
  const test = await fixture();
  await test.run();
  const read = vi.mocked(
    test.session.snapshotRead as NonNullable<RelaySession["snapshotRead"]>,
  );
  const original = read.getMockImplementation();
  if (!original) throw new Error("Missing fixture reader");
  read.mockImplementation(async (filters, options) =>
    filters[0]?.["#t"]
      ? Array.from({ length: 500 }, () =>
          signed(test.agent, {
            kind: 9,
            content: "report",
            tags: [["h", channel]],
          }),
        )
      : original(filters, options),
  );
  await expect(
    loadSubmissions(test.session, channel, new AbortController().signal),
  ).rejects.toThrow("read reached its limit");
});

async function triageFixture() {
  const f = await fixture();
  const { DEFAULT_ADMISSION } = await import("./configuration");
  const { recordTriageDecision } = await import("../../buzz-mcp/pr-triage");
  const config = {
    ...f.config,
    config: {
      ...f.config.config,
      admission: {
        ...DEFAULT_ADMISSION,
        triage: true,
        agent: f.agent.pubkey,
        instructions: "Reject duplicates.",
      },
    },
  };
  const facts = {
    repository: config.config.repository,
    pr: 123,
    title: "Fix",
    labels: [],
    paths: ["src/a.ts"],
    changedFiles: 1,
    head: "a".repeat(40),
    base: "b".repeat(40),
  };
  const admission = vi.fn(async () => ({
    head: facts.head,
    open: true,
    draft: false,
    mergeable: true,
    ci: "pass" as const,
  }));
  const run = () =>
    submitReview(
      f.session,
      channel,
      config,
      "123",
      [f.agent.pubkey, f.agent.pubkey],
      new AbortController().signal,
      () => {},
      true,
      () => Promise.resolve(facts),
      undefined,
      "Review tool docs",
      { read: admission, documentation: "Triage tool docs" },
    );
  const client = {
    pubkey: f.agent.pubkey,
    query: (filters: ReadFilter[]) => f.session.snapshotRead?.(filters, {}),
    publish: async (template: Parameters<typeof signed>[1]) => {
      const event = signed(f.agent, template);
      f.messages.set(event.id, event);
      return event;
    },
  } as unknown as import("../../buzz-mcp/client").BuzzClient;
  const decide = (
    root: string,
    decision: "admit" | "reject",
    message = "Decision reason",
  ) =>
    recordTriageDecision(
      client,
      { review: { channel, root } },
      { decision, message },
    );
  return { ...f, config, facts, admission, run, decide, client };
}

it("runs enabled admission checks before creating any submission or thread", async () => {
  const f = await triageFixture();
  f.config.config.admission.ready = true;
  f.admission.mockResolvedValue({
    head: f.facts.head,
    open: true,
    draft: true,
    mergeable: true,
    ci: "pass",
  });
  await expect(f.run()).rejects.toThrow("still a draft");
  expect(f.heads.size).toBe(0);
  expect(f.messages.size).toBe(0);
  f.config.config.admission.ready = false;
  await f.run();
  expect(f.admission).toHaveBeenCalledTimes(1);
  expect(f.messages.size).toBe(1);
});

it("triages once, accepts a trusted tool decision, then routes exactly once", async () => {
  const f = await triageFixture();
  const pending = await f.run();
  expect(pending.value.triage?.state).toBe("pending");
  expect(pending.value.threads).toEqual([]);
  expect(f.messages.size).toBe(1);
  const root = pending.value.triage?.thread.id ?? "";
  expect(f.messages.get(root)?.content).toContain("Triage tool docs");
  expect(f.messages.get(root)?.content).toContain("Reject duplicates.");
  await expect(f.decide(root, "admit")).resolves.toContain("saved");
  await expect(f.decide(root, "admit")).resolves.toContain("already saved");
  const admitted = await f.run();
  expect(admitted.value.triage?.state).toBe("admitted");
  expect(admitted.value.threads).toHaveLength(2);
  expect(admitted.value.threads.every((thread) => thread.delivered)).toBe(true);
  expect(f.messages.size).toBe(4); // Triage, signed decision, two lane requests.
  const again = await f.run();
  expect(again.value.threads).toEqual(admitted.value.threads);
  expect(f.messages.size).toBe(4);
  expect(
    (await loadSubmissions(f.session, channel, new AbortController().signal))
      .rows[0]?.value.triage?.state,
  ).toBe("admitted");
  await expect(f.decide(root, "reject")).rejects.toThrow(
    "final triage decision",
  );
});

it("rejects without lane requests and isolates a new triage after deletion", async () => {
  const f = await triageFixture();
  const pending = await f.run();
  const root = pending.value.triage?.thread.id ?? "";
  await f.decide(root, "reject", "Duplicate of #10");
  const rejected = await f.run();
  expect(rejected.value.triage).toMatchObject({
    state: "rejected",
    message: "Duplicate of #10",
  });
  expect(f.messages.size).toBe(2);
  await expect(
    remindSubmission(
      f.session,
      channel,
      rejected,
      new AbortController().signal,
      async () => "Open",
    ),
  ).rejects.toThrow("not been admitted");
  await deleteSubmission(
    f.session,
    channel,
    rejected,
    new AbortController().signal,
  );
  const fresh = await f.run();
  expect(fresh.value.triage?.thread.id).not.toBe(root);
  expect(fresh.value.triage?.state).toBe("pending");
  await expect(f.decide(root, "admit")).rejects.toThrow(
    "no unique active triage",
  );
});

it("refuses stale commit decisions, foreign callers, model targeting and missing host context", async () => {
  const f = await triageFixture();
  const { recordTriageDecision } = await import("../../buzz-mcp/pr-triage");
  const pending = await f.run();
  const root = pending.value.triage?.thread.id ?? "";
  await expect(
    recordTriageDecision(f.client, {}, { decision: "admit", message: "ok" }),
  ).rejects.toThrow("host has not supplied");
  await expect(
    recordTriageDecision(
      f.client,
      { review: { channel, root } },
      { decision: "admit", message: "ok", pr: 123 },
    ),
  ).rejects.toThrow("Supply only");
  await expect(
    recordTriageDecision(
      { ...f.client, pubkey: keypair().pubkey },
      { review: { channel, root } },
      { decision: "admit", message: "ok" },
    ),
  ).rejects.toThrow("no unique active triage");
  await f.decide(root, "admit");
  f.facts.head = "c".repeat(40);
  const result = await f.run();
  expect(result.value.triage?.state).toBe("rejected");
  expect(result.value.triage?.message).toContain("PR changed");
  expect(result.value.threads).toEqual([]);
});

it("automatically resumes after an offline decision with no PR page mounted", async () => {
  const f = await triageFixture();
  const pending = await f.run();
  await f.decide(pending.value.triage?.thread.id ?? "", "admit");
  const { watchTriage } = await import("./triage-coordinator");
  const { pendingTriage } = await import("./triage-recovery");
  vi.stubGlobal("window", new EventTarget());
  const listeners = new Set<(batch: { events: EventData[] }) => void>();
  Object.assign(f.session, {
    subscribeLive: (listener: (batch: { events: EventData[] }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    live: {
      snapshot: () => ({ status: "connected" }),
      subscribe: () => () => {},
    },
  });
  const stop = watchTriage(
    f.session,
    async () => f.facts,
    f.admission,
    (name) => name,
  );
  cleanups.push(stop);
  // Replay is an explicit recovery trigger, independent of startup jitter.
  for (const listener of listeners)
    listener({ events: [...f.messages.values()] });
  await vi.waitFor(() => expect(pendingTriage(f.session.scope)).toEqual([]));
  const rows = await loadSubmissions(
    f.session,
    channel,
    new AbortController().signal,
  );
  expect(rows.rows[0]?.value.triage?.state).toBe("admitted");
  expect(f.messages.size).toBe(4);
  for (const listener of listeners)
    listener({ events: [...f.messages.values()] });
  stop();
  expect(f.messages.size).toBe(4);
});

it("serializes opposing triage tool calls and never confirms both decisions", async () => {
  const f = await triageFixture();
  const pending = await f.run();
  const root = pending.value.triage?.thread.id ?? "";
  const original = f.client.publish.bind(f.client);
  let release: () => void = () => {};
  let started: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const publish = vi.fn(async (event: Parameters<typeof original>[0]) => {
    started();
    await gate;
    return original(event);
  });
  Object.assign(f.client, { publish });
  const admit = f.decide(root, "admit");
  await entered;
  const reject = f.decide(root, "reject");
  const refused = expect(reject).rejects.toThrow("final triage decision");
  try {
    expect(publish).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await admit;
  await refused;
  expect(publish).toHaveBeenCalledTimes(1);
  expect((await f.run()).value.triage?.state).toBe("admitted");
});

it("reminds only the selected lane and preserves another lane's completed review", async () => {
  const test = await fixture();
  const first = await test.run();
  for (const [index, thread] of first.value.threads.entries()) {
    const event = signed(test.agent, {
      kind: 9,
      content: "Review complete",
      tags: [
        ["h", channel],
        ["e", thread.id ?? "", "", "reply"],
        ["t", "buzz.review.status"],
        ["r", thread.request ?? ""],
        ["review", first.artifactId, String(index)],
        ["review-sequence", "1"],
        ["status", "done"],
      ],
    });
    test.messages.set(event.id, event);
  }
  const signal = new AbortController().signal;
  expect(
    (await loadSubmissions(test.session, channel, signal)).rows[0]
      ?.reviewStates,
  ).toEqual(["done", "done"]);
  const updated = await remindSubmission(
    test.session,
    channel,
    first,
    signal,
    async () => "Open",
    "tool instructions",
    "backend",
  );
  expect(updated.value.threads[0]?.request).not.toBe(
    first.value.threads[0]?.request,
  );
  expect(updated.value.threads[1]).toEqual(first.value.threads[1]);
  expect(
    (await loadSubmissions(test.session, channel, signal)).rows[0]
      ?.reviewStates,
  ).toEqual(["need_review", "done"]);
  const reminders = [...test.messages.values()].filter((event) =>
    event.content.startsWith("**Review reminder.**"),
  );
  expect(reminders).toHaveLength(1);
  expect(reminders[0]?.tags).toContainEqual([
    "e",
    first.value.threads[0]?.id,
    "",
    "reply",
  ]);
  expect(updated.value.notifyingLane).toBeUndefined();
  await expect(
    remindSubmission(
      test.session,
      channel,
      updated,
      signal,
      async () => "Open",
      "",
      "absent",
    ),
  ).rejects.toThrow("lane is unavailable");
  expect(test.publish).toHaveBeenCalledTimes(3);
});

it("resumes a failed lane reminder without duplicating it or switching lanes", async () => {
  const test = await fixture();
  const first = await test.run();
  const signal = new AbortController().signal;
  test.publish.mockRejectedValueOnce(new Error("offline"));
  await expect(
    remindSubmission(
      test.session,
      channel,
      first,
      signal,
      async () => "Open",
      "",
      "backend",
    ),
  ).rejects.toThrow("offline");
  const pending = (await loadSubmissions(test.session, channel, signal))
    .rows[0];
  if (!pending) throw new Error("Missing submission");
  expect(pending.value.notifyingLane).toBe("backend");
  expect(pending.value.threads[1]).toEqual(first.value.threads[1]);
  await expect(
    remindSubmission(
      test.session,
      channel,
      pending,
      signal,
      async () => "Open",
      "",
      "ui",
    ),
  ).rejects.toThrow("Finish the pending reminder");
  await remindSubmission(
    test.session,
    channel,
    pending,
    signal,
    async () => "Open",
    "",
    "backend",
  );
  expect(test.publish).toHaveBeenCalledTimes(4);
  expect(test.publish.mock.calls[2]?.[0].id).toBe(
    test.publish.mock.calls[3]?.[0].id,
  );
  const completed = (await loadSubmissions(test.session, channel, signal))
    .rows[0];
  expect(completed?.value.notifying).toBeUndefined();
  expect(completed?.value.notifyingLane).toBeUndefined();
});

it("keeps current statuses readable when historical review reports reach the cap", async () => {
  const test = await fixture();
  await test.run();
  const read = vi.mocked(
    test.session.snapshotRead as NonNullable<RelaySession["snapshotRead"]>,
  );
  const original = read.getMockImplementation();
  if (!original) throw new Error("Missing fixture reader");
  read.mockImplementation(async (filters, options) =>
    filters[0]?.["#t"] && filters[0]?.["#e"]
      ? Array.from({ length: 500 }, () =>
          signed(test.agent, {
            kind: 9,
            content: "historical report",
            tags: [["h", channel]],
          }),
        )
      : original(filters, options),
  );
  const result = await loadSubmissions(
    test.session,
    channel,
    new AbortController().signal,
  );
  expect(result.rows[0]?.reviewStates).toEqual(["need_review", "need_review"]);
  expect(result.rows[0]?.reviewHistoryIncomplete).toBe(true);
  expect(result.warning).toContain("last-reviewed dates are unavailable");
});
