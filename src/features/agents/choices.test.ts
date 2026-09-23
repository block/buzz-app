import { expect, it } from "vitest";
import { createAgentControl } from "./control";
import { controlFixture } from "./control-testing";
import { createAgentLibrary } from "./library";
import { createAgentChoices, templateAgentChoices } from "./choices";
import { sessionRecipients } from "../sessions/recipients";

const viewer = "aa".repeat(32);
const scope = `https://relay.example.test:${viewer}`;

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
    signal: lifetime.signal,
  });
  await choices.refresh();
  expect(choices.snapshot().identities).toEqual([
    { ...duplicate, managed: true },
    { ...namesake, managed: false },
  ]);
  expect(
    templateAgentChoices(choices.snapshot(), { status: "ready", channels: [] }),
  ).toEqual([{ ...duplicate, managed: true }]);
  const elsewhere = createAgentChoices({
    scope: `https://elsewhere.test:${viewer}`,
    library: createAgentLibrary(undefined).queries,
    native,
    signal: lifetime.signal,
  });
  expect(elsewhere.snapshot().identities).toEqual([]);
  expect(fixture.calls.every((call) => call.action === "snapshot")).toBe(true);
  lifetime.abort();
  expect(choices.snapshot().identities).toEqual([]);
  library.dispose();
  native.dispose();
});

it.each(["loading", "failed"])(
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
      throw new Error("unavailable legacy source");
    });
    const lifetime = new AbortController();
    const choices = createAgentChoices({
      scope,
      library: library.queries,
      native,
      signal: lifetime.signal,
    });
    const pending = choices.refresh();
    await Promise.resolve();
    if (mode === "failed") await pending;
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
    expect(choices.snapshot().error).toContain("Could not read");
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
