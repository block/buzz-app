import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  vi.spyOn(crypto, "randomUUID").mockReturnValue(HOME);
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
  expect(h.events.map((event) => event.kind)).toEqual([30177, 9007, 9000, 9]);
  expect(h.channels.get(HOME)).toEqual({
    visibility: "private",
    members: [h.viewer, h.agent],
  });
  expect(h.events[2]?.tags).toContainEqual(["role", "bot"]);
  expect(h.instructions()).toBe(bestieInstructions(h.viewer, HOME));
  expect(h.events[3]).toMatchObject({
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
  expect(h.sign).toHaveBeenCalledTimes(signatures);
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
