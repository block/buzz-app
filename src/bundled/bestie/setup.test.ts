import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { RHYTHMS, rhythmYaml } from "./rhythms";
import { deferred } from "../builderlab/test-helpers";
import { bestieInstructions, PROMPT_VERSION } from "./prompt";
import { createRemoteBestie } from "./setup";
import { bestieFixture as fixture, cleanups, COMMUNITY, HOME } from "./testing";

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  let nextId = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
    nextId++ === 0
      ? HOME
      : `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
  );
});

it("saves three paused, owner-signed rhythms and opens setup only after signed readback", async () => {
  const h = await fixture();
  await h.bestie.setup();
  const definitions = h.events.filter((event) => event.kind === 30620);
  expect(definitions).toHaveLength(3);
  expect(
    new Set(
      definitions.map((event) => event.tags.find(([key]) => key === "d")?.[1]),
    ).size,
  ).toBe(3);
  for (const [index, event] of definitions.entries()) {
    expect(event.pubkey).toBe(h.viewer);
    expect(event.tags).toContainEqual(["h", HOME]);
    const rhythm = RHYTHMS[index];
    if (!rhythm) throw new Error("Missing rhythm");
    expect(event.content).toBe(rhythmYaml(rhythm, h.agent, HOME));
    expect(parse(event.content)).toMatchObject({
      enabled: false,
      trigger: { on: "schedule" },
      steps: [{ action: "send_message" }],
    });
  }
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.bestie.snapshot().record?.rhythms).toMatchObject({
    memory: { eventId: definitions[0]?.id },
    reflection: { eventId: definitions[1]?.id },
    "check-in": { eventId: definitions[2]?.id },
  });
});

it("preserves edited and enabled rhythms on retry and restart without saving another definition", async () => {
  const h = await fixture();
  await h.bestie.setup();
  const first = h.events.find((event) => event.kind === 30620);
  if (!first) throw new Error("Missing workflow");
  const edit = await h.sign({
    kind: 30620,
    created_at: first.created_at + 1,
    tags: first.tags,
    content: first.content
      .replace("enabled: false", "enabled: true")
      .replace("interval: 1h", "interval: 4h"),
  });
  h.events.push(edit);
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(3);
  expect(h.events.at(-1)?.content).toBe(edit.content);
});

it("recovers a workflow applied before receipt loss without a duplicate save", async () => {
  const h = await fixture();
  h.failPublication(30620, false, true);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(1);
  await h.restart();
  h.revealReceived();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(3);
  expect(h.requests("register-agent")).toHaveLength(1);
});

it("retains an unknown workflow intent across restart and refuses to allocate another", async () => {
  const h = await fixture();
  h.failPublication(30620);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("unconfirmed"),
  });
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(1);
});

it("recovers an edited workflow after receipt loss using its persisted coordinate", async () => {
  const h = await fixture();
  h.failPublication(30620, false, true);
  await h.bestie.setup();
  const first = h.events.find((event) => event.kind === 30620);
  if (!first) throw new Error("Missing saved workflow");
  expect(h.bestie.snapshot().status).toBe("error");
  const edit = await h.sign({
    kind: 30620,
    created_at: first.created_at + 1,
    tags: first.tags,
    content: first.content.replace("interval: 1h", "interval: 6h"),
  });
  h.events.push(edit);
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(3);
  const view = h.session.workflows.definitions(HOME);
  try {
    await view.refresh();
    expect(
      view.snapshot().data.items.some((row) => row.yaml === edit.content),
    ).toBe(true);
  } finally {
    view.dispose();
  }
});

it("replaces only a definitely rejected and durably dismissed workflow intent", async () => {
  const h = await fixture();
  h.failPublication(30620, true);
  await h.bestie.setup();
  const rejected = h.session.workflows.operations.snapshot()[0];
  if (!rejected) throw new Error("Missing rejected operation");
  expect(rejected.delivery).toBe("failed");
  await h.session.workflows.operations.dismiss(rejected.eventId);
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(4);
  expect(h.events.filter((event) => event.kind === 30620)).toHaveLength(3);
});

it("refuses creation after an unavailable definition read", async () => {
  const h = await fixture();
  const query = h.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  h.query.mockImplementation((filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30620)))
      throw new Error("unavailable");
    return query(filters);
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(0);
});

it("preserves a user removal instead of recreating a saved rhythm", async () => {
  const h = await fixture();
  await h.bestie.setup();
  const index = h.events.findIndex((event) => event.kind === 30620);
  h.events.splice(index, 1);
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("removed"),
  });
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(3);
});

it("upgrades a completed basic setup without another agent, welcome, or instruction update", async () => {
  const writes = vi.spyOn(localStorage, "setItem");
  const h = await fixture();
  await h.bestie.setup();
  const key = writes.mock.calls.find(([name]) =>
    name.startsWith("buzz.remote-bestie.v1:"),
  )?.[0];
  const record = h.bestie.snapshot().record;
  if (!key || !record) throw new Error("Missing completed setup");
  const basic = structuredClone(record);
  delete basic.rhythms;
  localStorage.setItem(key, JSON.stringify(basic));
  for (let index = h.events.length - 1; index >= 0; index--)
    if (h.events[index]?.kind === 30620) h.events.splice(index, 1);
  await h.restart();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "idle",
    record: { complete: true },
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9)).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 30620)).toHaveLength(3);
});

it("stops workflow saves when the community changes during definition readback", async () => {
  const h = await fixture();
  const query = h.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  const started = deferred<void>();
  const gate = deferred<void>();
  h.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30620))) {
      started.resolve();
      await gate.promise;
    }
    return query(filters);
  });
  const setup = h.bestie.setup();
  try {
    await started.promise;
    h.setCommunity(null);
  } finally {
    gate.resolve();
  }
  await setup;
  expect(h.bestie.snapshot()).toMatchObject({
    status: "unavailable",
    prerequisite: "community",
  });
  expect(
    h.publish.mock.calls.filter(([event]) => event.kind === 30620),
  ).toHaveLength(0);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("registers and authorizes one remote Bestie, invites it privately, and welcomes it through the real outbox", async () => {
  const h = await fixture();
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: {
      channelId: HOME,
      owner: h.viewer,
      agent: { pubkey: h.agent, status: "Active" },
      promptVersion: PROMPT_VERSION,
      complete: true,
    },
  });
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("attest-agent")).toHaveLength(1);
  expect(h.authorize).toHaveBeenCalledWith(h.agent, expect.any(AbortSignal));
  const attestation = h.requests("attest-agent")[0]?.[0];
  expect(JSON.parse(attestation?.body ?? "{}")).toMatchObject({
    agent_pubkey: h.agent,
    community_url: COMMUNITY,
    owner_auth_tag_json: JSON.stringify([
      "auth",
      h.viewer,
      "",
      "ab".repeat(64),
    ]),
  });
  expect(h.events.map((event) => event.kind)).toEqual([
    30177, 9007, 9000, 9, 30620, 30620, 30620,
  ]);
  expect(h.channels.get(HOME)).toEqual({
    visibility: "private",
    members: [h.viewer, h.agent],
  });
  expect(h.events[2]?.tags).toContainEqual(["role", "bot"]);
  expect(h.instructions()).toBe(bestieInstructions(h.viewer, HOME));
  expect(h.events.find((event) => event.kind === 9)).toMatchObject({
    content: "🤖 @Bestie Introduce yourself and help me get started with Buzz.",
    tags: expect.arrayContaining([
      ["h", HOME],
      ["p", h.agent],
    ]),
  });
});

it("resumes a failed welcome after session restart without another agent, channel, invitation, or signature", async () => {
  const h = await fixture();
  h.failPublication(9);
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({ status: "error" });
  const welcome = h.publish.mock.calls.find(([event]) => event.kind === 9)?.[0];
  expect(welcome).toBeDefined();
  const signatures = h.sign.mock.calls.length;
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9007)).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9000)).toHaveLength(1);
  expect(h.sign).toHaveBeenCalledTimes(signatures + 3);
  expect(
    h.publish.mock.calls
      .filter(([event]) => event.kind === 9)
      .map(([event]) => event),
  ).toEqual([welcome, welcome]);
});

it.each([9007, 9])(
  "recovers a definitely rejected and explicitly dismissed kind %s operation without duplicating setup resources",
  async (kind) => {
    const h = await fixture();
    h.failPublication(kind, true);
    await h.bestie.setup();
    expect(h.bestie.snapshot().status).toBe("error");
    const failed = h.session.outbox
      ?.snapshot()
      .find((item) => item.event.kind === kind && item.delivery === "failed");
    expect(failed).toBeDefined();
    if (!failed || !h.session.outbox)
      throw new Error("Missing failed operation");
    await h.session.outbox.dismiss(failed.event.id);
    expect(
      h.session.outbox
        .snapshot()
        .some((item) => item.event.id === failed.event.id),
    ).toBe(false);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    await h.bestie.setup();
    expect(h.bestie.snapshot().status).toBe("ready");
    expect(h.requests("register-agent")).toHaveLength(1);
    expect(h.requests("update-agent")).toHaveLength(1);
    expect(h.channels.size).toBe(1);
    expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
    expect(h.events.filter((event) => event.kind === 9007)).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === 9000)).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === 9)).toHaveLength(1);
    const replacement = h.events.find((event) => event.kind === kind);
    expect(replacement?.id).not.toBe(failed.event.id);
  },
);

it("does not replace a channel whose rejected attempt later became unconfirmed, even after dismissal", async () => {
  const h = await fixture();
  h.failPublication(9007, true);
  await h.bestie.setup();
  const failed = h.session.outbox
    ?.snapshot()
    .find((item) => item.event.kind === 9007 && item.delivery === "failed");
  expect(failed).toBeDefined();
  if (!failed || !h.session.outbox) throw new Error("Missing failed operation");

  h.failPublication(9007, false, true);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(
    h.session.outbox
      .snapshot()
      .find((item) => item.event.id === failed.event.id),
  ).toMatchObject({ delivery: "unknown" });
  await h.session.outbox.dismiss(failed.event.id);
  expect(
    h.session.outbox
      .snapshot()
      .some((item) => item.event.id === failed.event.id),
  ).toBe(false);

  // Dismissal cannot restore permission from the earlier definite rejection.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(
    h.publish.mock.calls
      .filter(([event]) => event.kind === 9007)
      .map(([event]) => event.id),
  ).toEqual([failed.event.id, failed.event.id]);
  expect(h.requests("register-agent")).toHaveLength(1);

  h.revealReceived();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.channels.size).toBe(1);
  expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
  expect(h.events.filter((event) => event.kind === 9007)).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9000)).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9)).toHaveLength(1);
});

it("retains an unknown welcome's durable identity even if the relay received it", async () => {
  const h = await fixture();
  h.failPublication(9, false, true);
  await h.bestie.setup();
  const unknown = h.session.outbox
    ?.snapshot()
    .find((item) => item.event.kind === 9 && item.delivery === "unknown");
  expect(unknown).toBeDefined();
  if (!unknown || !h.session.outbox)
    throw new Error("Missing unknown operation");
  await expect(h.session.outbox.dismiss(unknown.event.id)).rejects.toThrow(
    "Confirm this message",
  );
  h.revealReceived();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(
    new Set(
      h.publish.mock.calls
        .filter(([event]) => event.kind === 9)
        .map(([event]) => event.id),
    ),
  ).toEqual(new Set([unknown.event.id]));
});

it.each([false, true])(
  "does not replace a dismissed unknown channel operation (relay applied: %s)",
  async (apply) => {
    const h = await fixture();
    h.failPublication(9007, false, apply);
    await h.bestie.setup();
    const unknown = h.session.outbox
      ?.snapshot()
      .find((item) => item.event.kind === 9007 && item.delivery === "unknown");
    expect(unknown).toBeDefined();
    if (!unknown || !h.session.outbox)
      throw new Error("Missing unknown operation");
    await h.session.outbox.dismiss(unknown.event.id);
    expect(
      h.session.outbox
        .snapshot()
        .some((item) => item.event.id === unknown.event.id),
    ).toBe(false);
    h.revealReceived();
    await h.bestie.setup();
    expect(h.bestie.snapshot().status).toBe(apply ? "ready" : "error");
    expect(
      h.publish.mock.calls.filter(([event]) => event.kind === 9007),
    ).toHaveLength(1);
    expect(h.requests("register-agent")).toHaveLength(1);
    expect(h.channels.size).toBe(apply ? 1 : 0);
  },
);

it.each(["open", "member"] as const)(
  "rejects an unsafe %s home before adding Bestie, changing instructions, or sending a welcome",
  async (change) => {
    const h = await fixture();
    h.unsafeHome(change);
    await h.bestie.setup();
    expect(h.bestie.snapshot()).toMatchObject({
      status: "error",
      message: expect.stringContaining(
        "private and contain only you and Bestie",
      ),
    });
    expect(h.events.map((event) => event.kind)).toEqual([30177, 9007]);
    expect(h.requests("update-agent")).toHaveLength(0);
  },
);

it.each(["account", "community"] as const)(
  "cancels late registration continuation when the %s changes",
  async (change) => {
    const h = await fixture();
    const gate = h.holdRequest("register-agent");
    const setup = h.bestie.setup();
    try {
      await vi.waitFor(() =>
        expect(h.requests("register-agent")).toHaveLength(1),
      );
      if (change === "account") await h.setAccount("other-account");
      else h.setCommunity("https://other.example");
      gate.resolve();
      await setup;
      expect(h.bestie.snapshot().status).not.toBe("ready");
      expect(h.requests("attest-agent")).toHaveLength(0);
      expect(h.requests("update-agent")).toHaveLength(0);
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await setup;
    }
  },
);

it("preserves custom instructions when reopened and resumed without duplicating setup", async () => {
  const h = await fixture();
  await h.bestie.setup();
  h.customize("Call me by my nickname. Keep my custom instructions.");
  h.bestie.dispose();
  const reopened = createRemoteBestie(h.builderlab, h.relay);
  cleanups.push(() => reopened.dispose());
  expect(reopened.snapshot().status).toBe("ready");
  await reopened.setup();
  expect(h.instructions()).toBe(
    "Call me by my nickname. Keep my custom instructions.",
  );
  expect(h.requests("update-agent")).toHaveLength(1);
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9)).toHaveLength(1);
});
