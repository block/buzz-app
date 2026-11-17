import { assert, expect, it, vi } from "vitest";
import {
  isExpiredSoloAdminSetup,
  promoteSoloAdmins,
  soloAdminRecovery,
} from "./solo-admins";
import { keypair, signed } from "./testing";
import { matchesEvent } from "./projection";
import type { OutgoingEvent } from "./outbox";
import type { ReadFilter, RelayEvent } from "./events";

function setup() {
  const owner = keypair(),
    relay = keypair();
  const agents: [string, string] = [keypair().pubkey, keypair().pubkey];
  const channel = crypto.randomUUID();
  const create = signed(owner, {
    kind: 9007,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", channel], ...agents.map((key) => ["p", key])],
  });
  const creation: OutgoingEvent = {
    event: create,
    delivery: "accepted",
    recovery: soloAdminRecovery(channel, agents, agents),
  };
  const records = new Map<string, RelayEvent>();
  const roles = new Map(agents.map((key) => [key, "member"]));
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
    agents,
    creation,
    records,
    roles,
    read,
    writer,
    publish,
    run,
  };
}

it("does not restore a removed opening agent when replaying a stale creation receipt", async () => {
  const h = setup();
  await h.run();
  h.roles.delete(h.agents[0]);
  await h.run(structuredClone(h.creation));
  expect(h.publish).toHaveBeenCalledTimes(2);
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

it("limits abandonment to a valid delivered and expired opening-admin receipt", () => {
  const h = setup();
  const recovery = h.creation.recovery;
  const createdAt = h.creation.event.created_at;
  assert.exists(recovery);
  assert.exists(createdAt);
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + 16 * 60 * 1000);
  try {
    expect(isExpiredSoloAdminSetup(h.creation)).toBe(true);
    for (const item of [
      { ...h.creation, delivery: "unknown" as const },
      { ...h.creation, recovery: undefined },
      {
        ...h.creation,
        recovery: { key: "another-owner", value: recovery.value },
      },
      {
        ...h.creation,
        recovery: { key: recovery.key, value: "invalid JSON" },
      },
      {
        ...h.creation,
        recovery: {
          key: recovery.key,
          value: JSON.stringify([keypair().pubkey]),
        },
      },
      { ...h.creation, event: { ...h.creation.event, kind: 9000 } },
    ])
      expect(isExpiredSoloAdminSetup(item)).toBe(false);
    clock.mockReturnValue((createdAt + 14 * 60) * 1000);
    expect(isExpiredSoloAdminSetup(h.creation)).toBe(false);
  } finally {
    clock.mockRestore();
  }
});
