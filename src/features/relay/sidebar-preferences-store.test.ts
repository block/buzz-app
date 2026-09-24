import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { flush, keypair, scriptedTransport } from "./testing";
import type {
  SidebarPreferences,
  SidebarMuteMutator,
} from "./sidebar-preferences";

const data: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: ["beta"],
  muted: [],
};
function setup(
  decode = vi.fn(async (): Promise<SidebarPreferences> => data),
  writeSidebarMute?: SidebarMuteMutator,
) {
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    decodeSidebarPreferences: decode,
    ...(writeSidebarMute ? { writeSidebarMute } : {}),
  });
  return { wire, owner, preferences: owner.session.sidebarPreferences, decode };
}

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("serializes mute writes without changing saved groups or stars", async () => {
  const gate = deferred<readonly string[]>();
  const started = deferred<void>();
  const mute = vi
    .fn<SidebarMuteMutator>()
    .mockImplementationOnce(async () => {
      started.resolve();
      return gate.promise;
    })
    .mockResolvedValueOnce(["alpha", "beta"]);
  const { wire, owner, preferences } = setup(undefined, mute);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const first = preferences.setMute("alpha", true);
    await started.promise;
    const second = preferences.setMute("beta", true);
    expect(mute).toHaveBeenCalledOnce();
    expect(preferences.snapshot().data).toEqual(data);
    gate.resolve(["alpha"]);
    await Promise.all([first, second]);
    expect(preferences.snapshot()).toEqual({
      status: "ready",
      data: { ...data, muted: ["alpha", "beta"] },
    });
    expect(Object.isFrozen(preferences.snapshot().data?.muted)).toBe(true);
  } finally {
    gate.resolve([]);
    owner.dispose();
  }
});
it("failed Mute retains the confirmed snapshot and a retry can unmute", async () => {
  const mute = vi
    .fn<SidebarMuteMutator>()
    .mockRejectedValueOnce(new Error("publish rejected"))
    .mockResolvedValueOnce([]);
  const { wire, owner, preferences } = setup(undefined, mute);
  try {
    const initial = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await initial;
    const retained = preferences.snapshot();
    await expect(preferences.setMute("beta", false)).rejects.toThrow(
      "publish rejected",
    );
    expect(preferences.snapshot()).toBe(retained);
    await preferences.setMute("beta", false);
    expect(preferences.snapshot().data).toEqual({ ...data, muted: [] });
  } finally {
    owner.dispose();
  }
});

it.each(["success", "failure"])(
  "a stale refresh %s cannot overwrite confirmed Mute",
  async (outcome) => {
    const gate = deferred<SidebarPreferences>();
    const started = deferred<void>();
    const decode = vi
      .fn(async () => data)
      .mockImplementationOnce(async () => data);
    const { wire, owner, preferences } = setup(decode, async () => [
      "alpha",
      "beta",
    ]);
    try {
      const initial = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await initial;
      decode.mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      const refresh = preferences.refresh();
      await flush();
      wire.next().respond([]);
      await started.promise;
      await preferences.setMute("alpha", true);
      const retained = preferences.snapshot();
      if (outcome === "success") gate.resolve(data);
      else gate.reject(new Error("old read failed"));
      await refresh;
      expect(preferences.snapshot()).toBe(retained);
      expect(retained.status).toBe("ready");
      expect(retained.data?.muted).toEqual(["alpha", "beta"]);
    } finally {
      gate.resolve(data);
      owner.dispose();
    }
  },
);

it.each(["clearCache", "dispose", "cancel"] as const)(
  "%s aborts Mute and fences active and queued writes",
  async (action) => {
    const gate = deferred<readonly string[]>();
    const started = deferred<AbortSignal>();
    const mute = vi.fn<SidebarMuteMutator>(async (_intent, signal) => {
      started.resolve(signal);
      return gate.promise;
    });
    const { wire, owner, preferences } = setup(undefined, mute);
    const caller = new AbortController();
    try {
      const initial = preferences.ensure();
      await flush();
      wire.next().respond([]);
      await initial;
      const pending = preferences.setMute("alpha", true, caller.signal);
      const activeSignal = await started.promise;
      const queued = preferences.setMute("beta", false, caller.signal);
      const result = Promise.allSettled([pending, queued]);
      if (action === "cancel") caller.abort();
      else await owner[action]();
      expect(activeSignal.aborted).toBe(true);
      gate.resolve(["alpha", "beta"]);
      expect((await result).map((entry) => entry.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(mute).toHaveBeenCalledOnce();
      expect(preferences.snapshot().data).toEqual(
        action === "cancel" ? data : undefined,
      );
    } finally {
      gate.resolve([]);
      owner.dispose();
    }
  },
);

it("does not mutate before a successful initial preference read or without host capability", async () => {
  const mute = vi.fn<SidebarMuteMutator>(async () => []);
  const { owner, preferences } = setup(undefined, mute);
  try {
    await expect(preferences.setMute("alpha", true)).rejects.toThrow(
      "unavailable",
    );
    expect(mute).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
  const readonly = setup();
  try {
    expect(readonly.preferences.muteWritable).toBe(false);
  } finally {
    readonly.owner.dispose();
  }
});
