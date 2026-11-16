import { assert, expect, it, vi } from "vitest";
import { promoteSoloAdmins, soloAdminRecovery } from "./solo-admins";
import { keypair, signed } from "./testing";
import { matchesEvent } from "./projection";
import type { OutgoingEvent } from "./outbox";
import type { ReadFilter, RelayEvent } from "./events";

function setup() {
  const owner = keypair(),
    relay = keypair();
  const agents: [string, string] = [keypair().pubkey, keypair().pubkey];
  const workspaceAgent = keypair().pubkey;
  const channel = crypto.randomUUID();
  const members = [...agents, workspaceAgent];
  const create = signed(owner, {
    kind: 9007,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", channel], ...members.map((key) => ["p", key])],
  });
  const creation: OutgoingEvent = {
    event: create,
    delivery: "accepted",
    recovery: soloAdminRecovery(channel, members, agents),
  };
  const records = new Map<string, RelayEvent>();
  const roles = new Map(members.map((key) => [key, "member"]));
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const roster = signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", channel],
        ["p", owner.pubkey, "", "owner"],
        ...[...roles].map(([key, role]) => ["p", key, "", role]),
      ],
    });
    return [...records.values(), roster].filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
  });
  const publish = vi.fn(async (event: RelayEvent) => {
    const agent = event.tags.find(([tag]) => tag === "p")?.[1];
    assert.exists(agent);
    records.set(event.id, event);
    roles.set(agent, "admin");
  });
  const writer = {
    sign: vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(owner, template),
    ),
    publish,
  };
  const controller = new AbortController();
  const run = (saved = creation) =>
    promoteSoloAdmins(saved, writer, { read }, relay.pubkey, controller.signal);
  return {
    owner,
    agents,
    workspaceAgent,
    channel,
    creation,
    records,
    roles,
    read,
    writer,
    publish,
    run,
    controller,
  };
}

it("promotes all opening agents in order, confirms a lost ACK, and leaves workspace-only agents ordinary", async () => {
  const h = setup();
  const normal = h.publish.getMockImplementation();
  assert.exists(normal);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.publish
    .mockImplementationOnce(async (event) => {
      await normal(event);
      throw new Error("ACK lost");
    })
    .mockImplementationOnce(async (event) => {
      entered();
      await held;
      await normal(event);
    });
  let finished = false;
  const work = h.run().then(() => {
    finished = true;
  });
  try {
    await started;
    expect(finished).toBe(false);
    expect(h.roles.get(h.agents[0])).toBe("admin");
    expect(h.roles.get(h.agents[1])).toBe("member");
    expect(h.roles.get(h.workspaceAgent)).toBe("member");
  } finally {
    release();
  }
  await work;
  expect(h.agents.map((key) => h.roles.get(key))).toEqual(["admin", "admin"]);
  expect(h.publish.mock.calls.map(([event]) => event.tags)).toEqual(
    h.agents.map((key) => [
      ["h", h.channel],
      ["p", key],
      ["role", "admin"],
    ]),
  );
  expect(
    h.publish.mock.calls.every(
      ([event]) =>
        event.pubkey === h.owner.pubkey &&
        event.created_at === h.creation.event.created_at,
    ),
  ).toBe(true);
});

it("resumes the exact failed grant after restart without restoring a demoted or removed opening agent", async () => {
  const h = setup();
  const normal = h.publish.getMockImplementation();
  assert.exists(normal);
  h.publish
    .mockImplementationOnce(normal)
    .mockRejectedValueOnce(new Error("offline"));
  await expect(h.run()).rejects.toThrow("offline");
  const failedId = h.publish.mock.calls[1]?.[0].id;
  h.roles.set(h.agents[0], "bot");
  await h.run(structuredClone(h.creation));
  expect(h.publish.mock.calls.map(([event]) => event.id).slice(1)).toEqual([
    failedId,
    failedId,
  ]);
  expect(h.roles.get(h.agents[0])).toBe("bot");
  h.roles.delete(h.agents[0]);
  await h.run(structuredClone(h.creation));
  expect(h.publish).toHaveBeenCalledTimes(3);
  expect(h.roles.has(h.agents[0])).toBe(false);
});

it.each(["owner", "guest", "absent"])(
  "preserves an opening agent changed to %s before its grant",
  async (role) => {
    const h = setup();
    if (role === "absent") h.roles.delete(h.agents[0]);
    else h.roles.set(h.agents[0], role);
    await expect(h.run()).rejects.toThrow("access changed");
    expect(h.publish).not.toHaveBeenCalled();
  },
);

it("keeps uncertainty recoverable when a publish claims success but no command is recorded", async () => {
  const h = setup();
  h.publish.mockResolvedValue(undefined);
  await expect(h.run()).rejects.toThrow("unconfirmed");
  expect(h.publish).toHaveBeenCalledOnce();
});

it("does not turn a failed role read into a permission grant", async () => {
  const h = setup();
  h.read.mockRejectedValueOnce(new Error("read offline"));
  await expect(h.run()).rejects.toThrow("read offline");
  expect(h.writer.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});

it("never re-dates an expired grant, but can still confirm recorded grants after expiry", async () => {
  const h = setup();
  await h.run();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60 * 1000);
  try {
    await h.run();
    h.records.clear();
    await expect(h.run()).rejects.toThrow("expired");
    expect(h.publish).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});

it("rejects recovery that grants a nonmember admin, without signing", async () => {
  const h = setup();
  assert.exists(h.creation.recovery);
  await expect(
    h.run({
      ...h.creation,
      recovery: {
        ...h.creation.recovery,
        value: JSON.stringify([keypair().pubkey]),
      },
    }),
  ).rejects.toThrow("initial chat agents");
  expect(h.writer.sign).not.toHaveBeenCalled();
});
