import { assert, expect, it } from "vitest";
import { createRelaySession } from "./session";
import { keypair, signed, scriptedTransport } from "./testing";
import { receivingProfileTemplate } from "../communities/receiving-profile";
import { TEST_RECEIVING_ADDRESS } from "../communities/receiving-profile-fixture";
import type { ReadTransport } from "./transport";

it.each(["update", "clear"] as const)(
  "%s publishes once through the narrow writer and updates the shared profile only after verified readback",
  async (operation) => {
    const viewer = keypair(),
      wire = scriptedTransport(viewer.pubkey, keypair().pubkey);
    let head = signed(viewer, {
      kind: 0,
      tags: [["keep", "tag"]],
      content: JSON.stringify({
        name: "Sam",
        about: "Bio",
        lud06: "old",
        lud16: TEST_RECEIVING_ADDRESS,
      }),
    });
    let sends = 0;
    wire.transport.query = async () => [head];
    const updateReceivingAddress: NonNullable<
      ReadTransport["updateReceivingAddress"]
    > = async (address, profile, signal) => {
      signal.throwIfAborted();
      sends++;
      head = signed(
        viewer,
        receivingProfileTemplate({ address, profile }, viewer.pubkey),
      );
      return head.id;
    };
    const store = createRelaySession({
      ...wire.transport,
      updateReceivingAddress,
    });
    try {
      expect(store.session.outbox?.supports(0)).toBeFalsy();
      assert(store.session.receivingAddress);
      const signal = new AbortController().signal;
      await expect(
        operation === "clear"
          ? store.session.receivingAddress.clear(signal)
          : store.session.receivingAddress.update(
              TEST_RECEIVING_ADDRESS,
              signal,
            ),
      ).resolves.toBe(
        operation === "clear" ? undefined : TEST_RECEIVING_ADDRESS,
      );
      expect(sends).toBe(1);
      expect(
        JSON.parse(
          store.session.profiles.event?.(viewer.pubkey)?.content ?? "null",
        ),
      ).toEqual({
        name: "Sam",
        about: "Bio",
        ...(operation === "update" ? { lud16: TEST_RECEIVING_ADDRESS } : {}),
      });
      expect(head.tags).toEqual([["keep", "tag"]]);
    } finally {
      store.dispose();
    }
  },
);

it.each(["update", "clear"] as const)(
  "%s does not retry publication or accept an unconfirmed readback, and fences disposed sessions",
  async (operation) => {
    const viewer = keypair(),
      wire = scriptedTransport(viewer.pubkey, keypair().pubkey);
    const head = signed(viewer, {
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: "Sam" }),
    });
    let sends = 0,
      fail = true;
    wire.transport.query = async () => [head];
    const updateReceivingAddress = async () => {
      sends++;
      if (fail) throw new Error("Unconfirmed publication");
      return "a".repeat(64);
    };
    const store = createRelaySession({
      ...wire.transport,
      updateReceivingAddress,
    });
    const receiving = store.session.receivingAddress;
    assert(receiving);
    const save = () =>
      operation === "clear"
        ? receiving.clear(new AbortController().signal)
        : receiving.update(
            TEST_RECEIVING_ADDRESS,
            new AbortController().signal,
          );
    try {
      await expect(save()).rejects.toThrow("Unconfirmed publication");
      expect(sends).toBe(1);
      fail = false;
      await expect(save()).rejects.toThrow("not been confirmed");
      expect(sends).toBe(2);
    } finally {
      store.dispose();
    }
    await expect(save()).rejects.toThrow();
    expect(sends).toBe(2);
  },
);

it("does not advertise profile writes on older or cached transports", () => {
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  const old = createRelaySession(wire.transport);
  const cached = createRelaySession(
    { ...wire.transport, updateReceivingAddress: async () => "a".repeat(64) },
    { cachedOnly: true },
  );
  try {
    expect(old.session.receivingAddress).toBeUndefined();
    expect(cached.session.receivingAddress).toBeUndefined();
  } finally {
    old.dispose();
    cached.dispose();
  }
});

it("keeps strong profile reads alive across channel discovery", async () => {
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, keypair().pubkey);
  let head = signed(viewer, {
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Sam" }),
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  wire.transport.query = async (filters) => {
    if (!filters.some((filter) => filter.kinds?.includes(0))) return [];
    entered();
    await gate;
    return [head];
  };
  let sends = 0;
  const store = createRelaySession({
    ...wire.transport,
    updateReceivingAddress: async (address, profile) => {
      sends++;
      head = signed(
        viewer,
        receivingProfileTemplate({ address, profile }, viewer.pubkey),
      );
      return head.id;
    },
  });
  assert(store.session.receivingAddress);
  const saving = store.session.receivingAddress.update(
    TEST_RECEIVING_ADDRESS,
    new AbortController().signal,
  );
  // Observe rejection immediately even if discovery fails before the final assertion.
  void saving.catch(() => {});
  try {
    await started;
    assert(store.session.channels.refreshList);
    await store.session.channels.refreshList();
    release();
    await expect(saving).resolves.toBe(TEST_RECEIVING_ADDRESS);
    expect(sends).toBe(1);
  } finally {
    release();
    store.dispose();
    await saving.catch(() => {});
  }
});

it.each(["older", "superseding"])(
  "rejects a %s readback even when its address matches",
  async (version) => {
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, keypair().pubkey);
    const old = signed(viewer, {
      kind: 0,
      tags: [],
      content: JSON.stringify({
        name: "Sam",
        lud16: TEST_RECEIVING_ADDRESS,
        lud06: "legacy",
      }),
    });
    let head = old;
    wire.transport.query = async () => [head];
    const store = createRelaySession({
      ...wire.transport,
      updateReceivingAddress: async (address, profile) => {
        const published = signed(
          viewer,
          receivingProfileTemplate({ address, profile }, viewer.pubkey),
        );
        if (version === "superseding")
          head = signed(viewer, {
            ...published,
            created_at: published.created_at + 1,
            content: JSON.stringify({ name: "Changed", lud16: address }),
          });
        return published.id;
      },
    });
    try {
      await expect(
        store.session.receivingAddress?.update(
          TEST_RECEIVING_ADDRESS,
          new AbortController().signal,
        ),
      ).rejects.toThrow("not been confirmed");
      expect(store.session.profiles.event?.(viewer.pubkey)?.id).toBe(head.id);
    } finally {
      store.dispose();
    }
  },
);

it.each(["older", "superseding"])(
  "rejects a %s clear readback even when both fields are absent",
  async (version) => {
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, keypair().pubkey);
    let head = signed(viewer, { kind: 0, tags: [], content: '{"name":"Sam"}' });
    wire.transport.query = async () => [head];
    const store = createRelaySession({
      ...wire.transport,
      updateReceivingAddress: async (address, profile) => {
        const published = signed(
          viewer,
          receivingProfileTemplate({ address, profile }, viewer.pubkey),
        );
        if (version === "superseding")
          head = signed(viewer, {
            ...published,
            created_at: published.created_at + 1,
            content: '{"name":"Changed"}',
          });
        return published.id;
      },
    });
    try {
      await expect(
        store.session.receivingAddress?.clear(new AbortController().signal),
      ).rejects.toThrow("not been confirmed");
      expect(store.session.profiles.event?.(viewer.pubkey)?.id).toBe(head.id);
    } finally {
      store.dispose();
    }
  },
);

it.each([
  { lud16: null },
  { lud16: TEST_RECEIVING_ADDRESS },
  { lud06: null },
  { lud06: "legacy" },
])(
  "rejects exact clear readback that retains receiving metadata %j",
  async (remaining) => {
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, keypair().pubkey);
    let head = signed(viewer, { kind: 0, tags: [], content: '{"name":"Sam"}' });
    wire.transport.query = async () => [head];
    const store = createRelaySession({
      ...wire.transport,
      updateReceivingAddress: async () => {
        head = signed(viewer, {
          kind: 0,
          tags: [],
          created_at: head.created_at + 1,
          content: JSON.stringify({ name: "Sam", ...remaining }),
        });
        return head.id;
      },
    });
    try {
      await expect(
        store.session.receivingAddress?.clear(new AbortController().signal),
      ).rejects.toThrow("not been confirmed");
    } finally {
      store.dispose();
    }
  },
);
