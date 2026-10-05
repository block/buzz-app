import { expect, it } from "vitest";
import { createAgentControl } from "./control";
import { controlFixture } from "./control-testing";
import { createAgentLibrary } from "./library";
import { createAgentChoices, templateAgentChoices } from "./choices";
import { sessionRecipients } from "../sessions/recipients";
import type { IdentityArchiveSnapshot } from "../relay/identity-archives";

const viewer = "aa".repeat(32);
const scope = `https://relay.example.test:${viewer}`;

/** Finite archive evidence with the real lazy-read lifecycle. */
function archiveFixture(
  archived: string[] = [],
  initial: IdentityArchiveSnapshot["status"] = "ready",
) {
  const listeners = new Set<() => void>();
  let snapshot: IdentityArchiveSnapshot = { status: initial, archived };
  const reads: string[] = [];
  const read = async () => {
    reads.push(snapshot.status);
    snapshot = { status: "ready", archived };
    for (const listener of listeners) listener();
  };
  return {
    reads,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: (key: string) =>
      snapshot.status !== "ready"
        ? ("unknown" as const)
        : snapshot.archived.includes(key)
          ? ("archived" as const)
          : ("not-archived" as const),
    ensure: () => (snapshot.status === "idle" ? read() : Promise.resolve()),
    refresh: read,
  };
}

it("merges exact keys, preserves namesakes and includes stopped native-only agents in their community", async () => {
  const fixture = controlFixture();
  fixture.agent.name = "Calvin";
  fixture.agent.status = "stopped";
  fixture.agent.enabled = false;
  const native = createAgentControl(fixture.host);
  const duplicate = { pubkey: fixture.agent.pubkey, name: "Old Calvin" };
  const namesake = { pubkey: "bc".repeat(32), name: "Calvin" };
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [duplicate, namesake],
  }));
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    native,
    archives: archiveFixture(),
    signal: lifetime.signal,
  });
  await choices.refresh();
  expect(choices.snapshot().identities).toEqual([
    { ...duplicate, managed: true, managedName: "Calvin" },
    { ...namesake, managed: false },
  ]);
  expect(
    templateAgentChoices(choices.snapshot(), { status: "ready", channels: [] }),
  ).toEqual([
    { ...duplicate, name: "Calvin", managed: true, managedName: "Calvin" },
  ]);
  const elsewhere = createAgentChoices({
    scope: `https://elsewhere.test:${viewer}`,
    library: createAgentLibrary(undefined).queries,
    native,
    archives: archiveFixture(),
    signal: lifetime.signal,
  });
  expect(elsewhere.snapshot().identities).toEqual([]);
  expect(fixture.calls.every((call) => call.action === "snapshot")).toBe(true);
  lifetime.abort();
  expect(choices.snapshot().identities).toEqual([]);
  library.dispose();
  native.dispose();
});

it.each(["loading", "failed", "partial"])(
  "keeps explicit native selection usable but blocks ambiguous automatic recipients with legacy %s",
  async (mode) => {
    const fixture = controlFixture();
    const native = createAgentControl(fixture.host);
    await native.refresh();
    let settle!: () => void;
    const library = createAgentLibrary(async () => {
      if (mode === "loading")
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
      if (mode === "partial")
        return {
          definitions: [],
          identities: [],
          error: "Local library unavailable",
        };
      throw new Error("unavailable legacy source");
    });
    const lifetime = new AbortController();
    const choices = createAgentChoices({
      scope,
      library: library.queries,
      native,
      archives: archiveFixture(),
      signal: lifetime.signal,
    });
    const pending = choices.refresh();
    await Promise.resolve();
    if (mode !== "loading") await pending;
    const state = choices.snapshot();
    const unknownLegacy = "cd".repeat(32);
    const channel = {
      id: "session",
      name: "Work",
      channelType: "session" as const,
      members: [viewer, fixture.agent.pubkey, unknownLegacy],
    };
    const profiles = new Map([[unknownLegacy, { name: "Legacy B" }]]);
    expect(state.status).toBe("ready");
    expect(state.complete).toBe(false);
    expect(state.templates).toMatchObject({
      status: "ready",
      complete: true,
      pending: false,
    });
    expect(state.templates.error).toBeUndefined();
    expect(() =>
      sessionRecipients(channel, profiles, state, viewer, []),
    ).toThrow(/still loading/);
    expect(
      sessionRecipients(channel, profiles, state, viewer, [
        fixture.agent.pubkey,
      ]),
    ).toEqual([fixture.agent.pubkey]);
    expect(
      templateAgentChoices(state, { status: "ready", channels: [] }).map(
        (a) => a.pubkey,
      ),
    ).toEqual([fixture.agent.pubkey]);
    if (mode === "loading") {
      settle();
      await pending;
    }
    expect(choices.snapshot().error).toContain(
      mode === "partial" ? "Local library unavailable" : "Could not read",
    );
    lifetime.abort();
    library.dispose();
    native.dispose();
  },
);

it("revokes failed native evidence without dropping ready legacy candidates, then retries and unsubscribes on retirement", async () => {
  const fixture = controlFixture();
  let failed = false;
  const native = createAgentControl({
    ...fixture.host,
    snapshot: async () => {
      if (failed) throw new Error("private native error");
      return fixture.host.snapshot();
    },
  });
  const legacy = { pubkey: "cd".repeat(32), name: "Legacy" };
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [legacy],
  }));
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    native,
    archives: archiveFixture(),
    signal: lifetime.signal,
  });
  let notifications = 0;
  const stop = choices.subscribe(() => {
    notifications++;
  });
  await choices.refresh();
  failed = true;
  await choices.refresh();
  expect(choices.snapshot().identities).toEqual([
    { ...legacy, managed: false },
  ]);
  expect(
    templateAgentChoices(choices.snapshot(), {
      status: "ready",
      channels: [{ id: "test", name: "Test", members: [legacy.pubkey] }],
    }),
  ).toEqual([]);
  expect(choices.snapshot().templates).toMatchObject({
    status: "error",
    complete: false,
    pending: false,
    identities: [],
    error: expect.stringContaining("Could not refresh local agents"),
  });
  expect(choices.snapshot().error).toContain("Could not refresh local agents");
  expect(choices.snapshot().error).not.toContain("private native");
  failed = false;
  await choices.refresh();
  expect(choices.snapshot().identities).toHaveLength(2);
  lifetime.abort();
  const retired = notifications;
  await native.refresh();
  expect(notifications).toBe(retired);
  expect(choices.snapshot().identities).toEqual([]);
  stop();
  library.dispose();
  native.dispose();
});

it("uses legacy roster choices only on hosts without native controls", async () => {
  const legacy = { pubkey: "bc".repeat(32), name: "Carl" };
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [legacy],
  }));
  const fixture = controlFixture();
  const native = createAgentControl(fixture.host);
  const lifetime = new AbortController();
  const channels = {
    status: "ready" as const,
    channels: [{ id: "test", name: "Test", members: [legacy.pubkey] }],
  };
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    native,
    archives: archiveFixture(),
    signal: lifetime.signal,
  });
  try {
    await library.queries.refresh();
    // Native idle is not evidence that the old library is the active inventory.
    expect(choices.snapshot().templates).toMatchObject({
      status: "idle",
      pending: true,
      complete: false,
    });
    expect(templateAgentChoices(choices.snapshot(), channels)).toEqual([]);
    await native.refresh();
    expect(
      templateAgentChoices(choices.snapshot(), channels).map((a) => a.pubkey),
    ).toEqual([fixture.agent.pubkey]);
    fixture.data.agents.length = 0;
    await native.refresh();
    expect(templateAgentChoices(choices.snapshot(), channels)).toEqual([]);
    const fallback = createAgentChoices({
      scope,
      library: library.queries,
      archives: archiveFixture(),
      signal: lifetime.signal,
    });
    expect(templateAgentChoices(fallback.snapshot(), channels)).toEqual([
      { ...legacy, managed: false },
    ]);
    expect(
      templateAgentChoices(fallback.snapshot(), {
        status: "ready",
        channels: [],
      }),
    ).toEqual([]);
  } finally {
    lifetime.abort();
    library.dispose();
    native.dispose();
  }
});

it("refreshes the selected template source without loading the unused legacy inventory", async () => {
  const fixture = controlFixture();
  const native = createAgentControl(fixture.host);
  let reads = 0;
  const library = createAgentLibrary(async () => {
    reads++;
    return { definitions: [], identities: [] };
  });
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    native,
    archives: archiveFixture(),
    signal: lifetime.signal,
  });
  try {
    await choices.refresh("templates");
    expect(reads).toBe(0);
    expect(choices.snapshot().templates).toMatchObject({
      status: "ready",
      complete: true,
      pending: false,
    });
    expect(library.queries.snapshot().status).toBe("idle");
    const legacy = createAgentChoices({
      scope,
      library: library.queries,
      archives: archiveFixture(),
      signal: lifetime.signal,
    });
    await legacy.refresh("templates");
    expect(reads).toBe(1);
    expect(legacy.snapshot().templates).toMatchObject({
      status: "ready",
      complete: true,
      pending: false,
    });
  } finally {
    lifetime.abort();
    library.dispose();
    native.dispose();
  }
});

it("hides known-archived agents from selection but keeps them as known agents", async () => {
  const archived = { pubkey: "bc".repeat(32), name: "Retired" };
  const active = { pubkey: "cd".repeat(32), name: "Active", definitionId: "p" };
  const library = createAgentLibrary(async () => ({
    definitions: [{ id: "p", name: "Profile", avatar: "https://a.test/p.png" }],
    identities: [archived, active],
  }));
  const archives = archiveFixture([archived.pubkey, viewer], "idle");
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    archives,
    signal: lifetime.signal,
  });
  const channels = {
    status: "ready" as const,
    channels: [
      { id: "c", name: "C", members: [archived.pubkey, active.pubkey] },
    ],
  };
  try {
    await library.queries.refresh();
    // Unknown archive state fails open for selection; templates need evidence.
    expect(choices.snapshot().selectable).toHaveLength(2);
    expect(templateAgentChoices(choices.snapshot(), channels)).toEqual([]);
    // Archive reads stay lazy until a selector demands them.
    choices.ensure();
    expect(archives.reads).toEqual([]);
    choices.ensure(true, true);
    await Promise.resolve();
    expect(archives.reads).toEqual(["idle"]);
    const state = choices.snapshot();
    expect(state.identities.map((a) => a.pubkey)).toEqual([
      archived.pubkey,
      active.pubkey,
    ]);
    expect(state.selectable).toEqual([
      { ...active, avatar: "https://a.test/p.png", managed: false },
    ]);
    expect(
      templateAgentChoices(state, channels).map((agent) => agent.pubkey),
    ).toEqual([active.pubkey]);
  } finally {
    lifetime.abort();
    library.dispose();
  }
});
