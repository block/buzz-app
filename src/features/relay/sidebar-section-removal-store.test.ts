import { expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarPreferences,
  SidebarSectionRemovalMutator,
  SidebarMuteMutator,
} from "./sidebar-preferences";
const data: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: ["alpha"],
  muted: ["beta"],
  sort: { channels: "recent" },
};
const removed = { sections: [], assignments: {} };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(
  remove: SidebarSectionRemovalMutator,
  mute?: SidebarMuteMutator,
) {
  const read = vi.fn(async () => data);
  const store = createSidebarPreferencesStore(
    read,
    true,
    undefined,
    undefined,
    undefined,
    mute,
    undefined,
    undefined,
    remove,
  );
  return { store, queries: store.queries, read };
}
it("retains confirmed data after removal failure and gates writes until a failed full read recovers", async () => {
  const remove = vi
    .fn<SidebarSectionRemovalMutator>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(removed);
  const f = setup(remove);
  try {
    await f.queries.ensure();
    await expect(f.queries.removeSection("work")).rejects.toThrow("offline");
    expect(f.queries.snapshot().data).toEqual(data);
    f.read.mockRejectedValueOnce(new Error("unreadable"));
    await f.queries.refresh();
    expect(f.queries.removeSectionWritable).toBe(false);
    await expect(f.queries.removeSection("work")).rejects.toThrow(
      "unavailable",
    );
    expect(remove).toHaveBeenCalledOnce();
    await f.queries.refresh();
    await f.queries.removeSection("work");
    expect(f.queries.snapshot().data).toEqual({ ...data, ...removed });
  } finally {
    f.store.dispose();
  }
});
it.each(["clear", "dispose"] as const)(
  "%s fences an accepted late removal confirmation",
  async (action) => {
    const entered = gate<AbortSignal>(),
      held = gate<typeof removed>();
    const remove = vi.fn<SidebarSectionRemovalMutator>(async (_id, signal) => {
      entered.resolve(signal);
      return held.promise;
    });
    const f = setup(remove);
    try {
      await f.queries.ensure();
      const result = f.queries.removeSection("work");
      const rejected = expect(result).rejects.toThrow("unavailable");
      const signal = await entered.promise;
      f.store[action]();
      expect(signal.aborted).toBe(true);
      held.resolve(removed);
      await rejected;
      expect(f.queries.snapshot().data).toBeUndefined();
    } finally {
      held.resolve(removed);
      f.store.dispose();
    }
  },
);
it("serializes removal with mute writes and preserves the separately confirmed fields", async () => {
  const entered = gate<void>(),
    held = gate<typeof removed>();
  const remove = vi.fn<SidebarSectionRemovalMutator>(async () => {
    entered.resolve();
    return held.promise;
  });
  const mute = vi.fn<SidebarMuteMutator>(async () => ["beta", "alpha"]);
  const f = setup(remove, mute);
  try {
    await f.queries.ensure();
    const removal = f.queries.removeSection("work");
    await entered.promise;
    const muting = f.queries.setMute("alpha", true);
    expect(mute).not.toHaveBeenCalled();
    expect(f.queries.snapshot().data).toEqual(data);
    held.resolve(removed);
    await Promise.all([removal, muting]);
    expect(f.queries.snapshot().data).toEqual({
      ...data,
      ...removed,
      muted: ["beta", "alpha"],
    });
  } finally {
    held.resolve(removed);
    f.store.dispose();
  }
});
