import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { flush, keypair, scriptedTransport } from "./testing";
import type {
  SidebarAssignmentMutator,
  SidebarPreferences,
} from "./sidebar-preferences";

const data: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: ["beta"],
};
function setup(
  decode = vi.fn(async (): Promise<SidebarPreferences> => data),
  write?: SidebarAssignmentMutator,
) {
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    decodeSidebarPreferences: decode,
    ...(write ? { writeSidebarAssignment: write } : {}),
  });
  return { wire, owner, preferences: owner.session.sidebarPreferences, decode };
}

it("applies a confirmed assignment to the retained session snapshot", async () => {
  const write = vi.fn<SidebarAssignmentMutator>(async () => ({
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "later" },
  }));
  const { wire, owner, preferences } = setup(undefined, write);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const listener = vi.fn();
    preferences.subscribe(listener);
    await expect(preferences.assign("alpha", "later")).resolves.toMatchObject({
      assignments: { alpha: "later" },
    });
    expect(write).toHaveBeenCalledWith(
      { channelId: "alpha", sectionId: "later" },
      expect.any(AbortSignal),
    );
    expect(preferences.snapshot()).toEqual({
      status: "ready",
      data: {
        sections: [
          { id: "work", name: "Work", order: 0 },
          { id: "later", name: "Later", order: 1 },
        ],
        assignments: { alpha: "later" },
        starred: ["beta"],
      },
    });
    expect(Object.isFrozen(preferences.snapshot().data?.assignments)).toBe(
      true,
    );
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});

it("keeps the last confirmed snapshot when an assignment fails", async () => {
  const write = vi.fn<SidebarAssignmentMutator>(async () => {
    throw new Error("relay rejected write");
  });
  const { wire, owner, preferences } = setup(undefined, write);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const retained = preferences.snapshot();
    await expect(preferences.assign("alpha")).rejects.toThrow(
      "relay rejected write",
    );
    expect(preferences.snapshot()).toBe(retained);
  } finally {
    owner.dispose();
  }
});

it("does not let an older refresh overwrite a confirmed assignment", async () => {
  let resolveDecode!: (value: SidebarPreferences) => void;
  const decode = vi.fn(
    async () =>
      new Promise<SidebarPreferences>((resolve) => {
        resolveDecode = resolve;
      }),
  );
  const write = vi.fn<SidebarAssignmentMutator>(async () => ({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
  }));
  const { wire, owner, preferences } = setup(decode, write);
  try {
    const refresh = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await flush();
    await preferences.assign("alpha", "work");
    resolveDecode({ ...data, assignments: {} });
    await refresh;
    expect(preferences.snapshot().data?.assignments).toEqual({ alpha: "work" });
  } finally {
    owner.dispose();
  }
});

it("rejects queued assignment results after session cache clear", async () => {
  let resolveWrite!: (
    value: Awaited<ReturnType<SidebarAssignmentMutator>>,
  ) => void;
  const write = vi.fn<SidebarAssignmentMutator>(
    async () =>
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
  );
  const { owner, preferences } = setup(undefined, write);
  const pending = preferences.assign("alpha", "work");
  await flush();
  await owner.clearCache();
  resolveWrite({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
  });
  await expect(pending).rejects.toThrow("unavailable");
  expect(preferences.snapshot()).toEqual({ status: "idle" });
  owner.dispose();
});
it("one session retains groups across observers and deduplicates initial reads", async () => {
  const { wire, owner, preferences, decode } = setup();
  try {
    const listener = vi.fn();
    const off = preferences.subscribe(listener);
    const first = preferences.ensure();
    const second = preferences.ensure();
    expect(second).toBe(first);
    await flush();
    wire.next().respond([]);
    await first;
    const retained = preferences.snapshot();
    expect(retained).toEqual({ status: "ready", data });
    expect(Object.isFrozen(retained.data?.sections[0])).toBe(true);
    off();
    const again = preferences.subscribe(listener);
    await preferences.ensure();
    expect(preferences.snapshot()).toBe(retained);
    expect(wire.pending).toHaveLength(0);
    expect(decode).toHaveBeenCalledTimes(1);
    again();
  } finally {
    owner.dispose();
  }
});

it("leaving the page does not abort the session's in-flight initial read", async () => {
  const { wire, owner, preferences } = setup();
  try {
    const off = preferences.subscribe(() => {});
    const pending = preferences.ensure();
    await flush();
    const read = wire.next();
    off();
    expect(read.signal?.aborted).toBe(false);
    read.respond([]);
    await pending;
    expect(preferences.snapshot()).toEqual({ status: "ready", data });
  } finally {
    owner.dispose();
  }
});

it("explicit refresh retains the last good groups through loading/error and can retry", async () => {
  const { wire, owner, preferences, decode } = setup();
  try {
    const first = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await first;
    const retained = preferences.snapshot().data;
    decode.mockRejectedValueOnce(new Error("decode failed"));
    const failed = preferences.refresh();
    expect(preferences.snapshot()).toEqual({
      status: "loading",
      data: retained,
    });
    await flush();
    wire.next().respond([]);
    await failed;
    expect(preferences.snapshot().status).toBe("error");
    expect(preferences.snapshot().data).toBe(retained);
    await preferences.ensure();
    expect(wire.pending).toHaveLength(0); // No automatic retry storm on remount.
    const retry = preferences.refresh();
    expect(preferences.snapshot().error).toBeUndefined();
    await flush();
    wire.next().respond([]);
    await retry;
    expect(preferences.snapshot()).toEqual({ status: "ready", data });
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "%s purges retained data and rejects late decoded completion",
  async (action) => {
    let resolve!: (data: SidebarPreferences) => void;
    let decodeSignal: AbortSignal | undefined;
    const { wire, owner, preferences } = setup(
      vi.fn((_events?: unknown, signal?: AbortSignal) => {
        decodeSignal = signal;
        return new Promise<SidebarPreferences>((done) => {
          resolve = done;
        });
      }),
    );
    try {
      const pending = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await flush();
      expect(decodeSignal?.aborted).toBe(false);
      await owner[action]();
      expect(decodeSignal?.aborted).toBe(true);
      expect(preferences.snapshot().data).toBeUndefined();
      resolve(data);
      await pending;
      expect(preferences.snapshot().data).toBeUndefined();
      expect(preferences.snapshot().status).toBe("idle");
      if (action === "dispose") {
        await preferences.ensure();
        expect(wire.pending).toHaveLength(0);
      }
    } finally {
      owner.dispose();
    }
  },
);

it("replacement viewer/community sessions do not reuse another session's groups", async () => {
  const a = setup(),
    b = setup();
  try {
    const first = a.preferences.ensure();
    await flush();
    a.wire.next().respond([]);
    await first;
    expect(a.preferences.snapshot().data).toEqual(data);
    expect(b.preferences.snapshot()).toEqual({ status: "idle" });
    a.owner.dispose();
    expect(a.preferences.snapshot().data).toBeUndefined();
    expect(b.preferences.snapshot().data).toBeUndefined();
  } finally {
    a.owner.dispose();
    b.owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "%s removes an already-ready snapshot",
  async (action) => {
    const { wire, owner, preferences } = setup();
    try {
      const first = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await first;
      expect(preferences.snapshot().data).toEqual(data);
      await owner[action]();
      expect(preferences.snapshot().data).toBeUndefined();
    } finally {
      owner.dispose();
    }
  },
);
