import { afterEach, expect, it, vi } from "vitest";
import { createAgentControl } from "../agents/control";
import { controlFixture } from "../agents/control-testing";
import { createRelaySession } from "../relay/session";
import { keypair, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import { startAddedAgent } from "./members";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});
async function setup(publicChannel = false) {
  const fixture = controlFixture();
  fixture.agent.status = "stopped";
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const viewer = keypair(),
    relay = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query: async (filters) =>
        [
          roster(
            relay,
            id,
            publicChannel
              ? [fixture.agent.pubkey]
              : [viewer.pubkey, fixture.agent.pubkey],
          ),
          signed(relay, {
            kind: 39000,
            content: "",
            tags: [
              ["d", id],
              ["t", "stream"],
              ...(publicChannel ? [["public"]] : []),
            ],
          }),
        ].filter((event) => filters.some((f) => matchesEvent(event, f))),
    },
    { agentChoices: control },
  );
  cleanup.push(owner.dispose, control.dispose);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  if (publicChannel)
    await owner.session.read([{ kinds: [39000, 39002], "#d": [id], limit: 2 }]);
  return {
    ...fixture,
    control,
    session: owner.session,
    start: (signal = new AbortController().signal) =>
      startAddedAgent(control, owner.session, id, fixture.agent.pubkey, signal),
  };
}
it("starts the exact local identity after membership, but never restarts an already running agent", async () => {
  const t = await setup();
  await t.start();
  await t.start();
  expect(t.calls.filter((call) => call.action === "start")).toEqual([
    { action: "start", payload: { id: t.agent.id } },
  ]);
});
it("a rejected start stays retryable even though the shared choice projection drops failed-source candidates", async () => {
  const t = await setup();
  const original = t.host.action;
  vi.spyOn(t.host, "action")
    .mockRejectedValueOnce(new Error("host unavailable"))
    .mockImplementation(original);
  await expect(t.start()).rejects.toThrow(/Added to the channel, but/);
  expect(t.session.agentChoices.snapshot().identities).toEqual([]);
  await t.start();
  expect(t.control.snapshot().data?.agents[0]?.status).toBe("running");
});
it("surfaces resolved-but-failed startup instead of reporting success", async () => {
  const t = await setup();
  vi.spyOn(t.host, "action").mockImplementation(async () => {
    t.agent.status = "failed";
    t.agent.error = "Missing credentials";
    return structuredClone(t.data);
  });
  await expect(t.start()).rejects.toThrow(/Missing credentials/);
});
it("never starts when the dialog has retired during the control refresh", async () => {
  const t = await setup();
  const abort = new AbortController();
  vi.spyOn(t.host, "snapshot").mockImplementation(async () => {
    abort.abort();
    return structuredClone(t.data);
  });
  await expect(t.start(abort.signal)).rejects.toThrow();
  expect(t.calls.some((call) => call.action === "start")).toBe(false);
});
it("never starts an identity managed in another community", async () => {
  const t = await setup();
  t.agent.relayUrl = "wss://other.example.test";
  await t.control.refresh();
  await t.start();
  expect(t.calls.some((call) => call.action === "start")).toBe(false);
});

it("starts a confirmed member of a public channel outside the joined-channel list", async () => {
  const t = await setup(true);
  expect(t.session.channels.list().channels).toEqual([]);
  await t.start();
  expect(t.calls.some((call) => call.action === "start")).toBe(true);
});
