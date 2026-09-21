import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createServices, type AppServices } from "./services";
import { controlFixture } from "../features/agents/control-testing";
import { keypair, metadata, roster, signed } from "../features/relay/testing";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter, RelayEvent } from "../features/relay/events";

// Exercise actual app composition, relay send/reply, outbox, control and IPC.
// Only host boundaries are synthetic. No real accounts, relay, keyring or GUI.
vi.mock("../bundled", () => ({ bundledPlugins: [] }));
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
let services: AppServices;
let fixture: ReturnType<typeof controlFixture>;
let release: (() => void) | undefined;
let publications: RelayEvent[];
let receipts: (() => void)[];
const viewer = keypair(),
  relay = keypair();
const origin = "https://relay.example.test";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  fixture = controlFixture();
  fixture.agent.enabled = false;
  fixture.agent.status = "stopped";
  publications = [];
  receipts = [];
  release = undefined;
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (cmd, args) => {
      if (cmd === "plugin_catalog")
        return {
          status: "ready",
          externalPluginsPaused: false,
          catalog: { profile: "test", location: "test", plugins: [] },
        };
      if (cmd === "agent_control_snapshot") return fixture.host.snapshot();
      if (cmd === "agent_control_action") {
        const { id, action } = args as { id: string; action: "start" | "stop" };
        return fixture.host.action(id, action);
      }
      throw new Error(`Unexpected IPC: ${cmd}`);
    });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/identity"))
        return Response.json({ viewer: viewer.pubkey });
      if (url.endsWith("/register")) return Response.json({});
      if (url.endsWith("/session"))
        return Response.json({
          viewer: viewer.pubkey,
          relayAuthor: relay.pubkey,
          relayUrl: origin,
          writeKinds: [9],
        });
      if (url.endsWith("/query")) {
        const filters = JSON.parse(options.body as string) as ReadFilter[];
        return Response.json(
          [
            roster(relay, "room", [viewer.pubkey, fixture.agent.pubkey]),
            metadata(relay, "room", "Room"),
          ].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      if (url.endsWith("/sign"))
        return Response.json(
          signed(viewer, JSON.parse(options.body as string)),
        );
      if (url.endsWith("/publish")) {
        const event = JSON.parse(options.body as string) as RelayEvent;
        publications.push(event);
        await new Promise<void>((resolve) => {
          release = resolve;
          receipts.push(resolve);
        });
        return Response.json({ accepted: true, event_id: event.id });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  services = createServices();
});
afterEach(async () => {
  for (const receipt of receipts) receipt();
  await services.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function open() {
  await vi.advanceTimersByTimeAsync(0);
  services.communities.joined(
    { id: origin, name: "Test" },
    { name: "Test", picture: "" },
  );
  await vi.advanceTimersByTimeAsync(0);
  const session = services.relay.snapshot().session;
  expect(session.channels.list().status).toBe("ready");
  return session;
}
function starts() {
  return vi
    .mocked(invoke)
    .mock.calls.filter(
      ([cmd, args]) =>
        cmd === "agent_control_action" &&
        (args as { action: string }).action === "start",
    );
}
for (const thread of [false, true]) {
  it(`production ${thread ? "thread" : "channel"} send starts the exact local identity only after confirmation`, async () => {
    const session = await open();
    const recipients = [fixture.agent.pubkey];
    if (thread)
      session.messages.reply(
        "room",
        "c".repeat(64),
        "@Agent hello",
        recipients,
      );
    else session.messages.send("room", "@Agent hello", recipients);
    await vi.advanceTimersByTimeAsync(0);
    expect(publications).toHaveLength(1);
    expect(starts()).toHaveLength(0);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts()).toEqual([
      [
        "agent_control_action",
        {
          id: fixture.agent.id,
          action: "start",
          replayFloor: publications[0]?.created_at,
        },
      ],
    ]);
    expect(fixture.agent.enabled).toBe(true);
    expect(publications[0]?.tags.some((tag) => tag[0] === "e")).toBe(thread);
  });
}
for (const change of ["switch", "stop", "disconnect", "dispose"] as const) {
  it(`${change} before confirmation preserves captured scope or cancels the pending wake`, async () => {
    const session = await open();
    await services.agentControl.refresh();
    session.messages.send("room", "@Agent hello", [fixture.agent.pubkey]);
    await vi.advanceTimersByTimeAsync(0);
    expect(publications).toHaveLength(1);
    if (change === "switch")
      services.communities.joined(
        { id: "https://other.example.test", name: "Other" },
        { name: "Test", picture: "" },
      );
    if (change === "stop")
      await services.agentControl.action(fixture.agent.id, "stop");
    if (change === "disconnect") services.relay.disconnect();
    if (change === "dispose") await services.dispose();
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts()).toHaveLength(change === "switch" ? 1 : 0);
    if (change === "switch")
      expect(starts()[0]?.[1]).toMatchObject({ id: fixture.agent.id });
    if (change === "stop") {
      session.messages.send("room", "@Agent later deliberate mention", [
        fixture.agent.pubkey,
      ]);
      await vi.advanceTimersByTimeAsync(0);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(starts()).toHaveLength(1);
    }
  });
}

it("plain mention text does not acquire local agent execution", async () => {
  const session = await open();
  session.messages.send("room", "@Fixture agent hello");
  await vi.advanceTimersByTimeAsync(0);
  release?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts()).toEqual([]);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([cmd]) => cmd === "agent_control_snapshot"),
  ).toBe(false);
});

it("newer-first confirmation starts with the older pending mention's replay floor", async () => {
  const session = await open();
  session.messages.send("room", "older", [fixture.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 30_000);
  session.messages.send("room", "newer", [fixture.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(publications).toHaveLength(2);
  expect(
    (publications[1]?.created_at ?? 0) - (publications[0]?.created_at ?? 0),
  ).toBe(30);
  receipts[1]?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts()).toHaveLength(1);
  expect(starts()[0]?.[1]).toMatchObject({
    replayFloor: publications[0]?.created_at,
  });
  receipts[0]?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts()).toHaveLength(1);
});

it("disconnect during the post-confirmation inventory read fences the late Start", async () => {
  const session = await open();
  let finish!: (data: typeof fixture.data) => void;
  const read = vi.spyOn(fixture.host, "snapshot").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  session.messages.send("room", "wake", [fixture.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  release?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  services.relay.disconnect();
  finish(structuredClone(fixture.data));
  await vi.advanceTimersByTimeAsync(0);
  expect(starts()).toEqual([]);
});

it("a native failure leaves confirmed message delivery intact and exposes a separate notice", async () => {
  const session = await open();
  vi.spyOn(fixture.host, "action").mockRejectedValue(
    "Stop old Buzz before starting this agent.",
  );
  session.messages.send("room", "wake", [fixture.agent.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  release?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.outbox?.snapshot()[0]?.delivery).toBe("accepted");
  expect(services.agentControl.snapshot().mentionError).toContain(
    "Message sent, but Fixture agent could not start",
  );
  expect(services.agentControl.snapshot().mentionError).toContain(
    "Stop old Buzz",
  );
});
