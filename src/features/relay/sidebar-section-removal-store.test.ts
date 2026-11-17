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
  muted: ["beta"],
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
  const store = createSidebarPreferencesStore({
    read,
    available: true,
    writeMute: mute,
    removeSection: remove,
  });
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

it.each(["success", "failure"] as const)(
  "settles a stale refresh after removal fails (read: %s)",
  async (outcome) => {
    const entered = gate<void>();
    const held = gate<SidebarPreferences>();
    const read = vi.fn(async () => data);
    const remove = vi
      .fn<SidebarSectionRemovalMutator>()
      .mockRejectedValue(new Error("remove offline"));
    const store = createSidebarPreferencesStore({
      read,
      available: true,
      removeSection: remove,
    });
    try {
      await store.queries.ensure();
      read.mockImplementationOnce(async () => {
        entered.resolve();
        await held.promise;
        if (outcome === "failure") throw new Error("stale read failed");
        return { ...data, assignments: {} };
      });
      const refresh = store.queries.refresh();
      await entered.promise;
      expect(store.queries.snapshot().status).toBe("loading");
      await expect(store.queries.removeSection("work")).rejects.toThrow(
        "remove offline",
      );
      held.resolve(data);
      await refresh;
      expect(remove).toHaveBeenCalledOnce();
      expect(store.queries.snapshot()).toEqual({ status: "ready", data });
      expect(store.queries.removeSectionWritable).toBe(true);
    } finally {
      held.resolve(data);
      store.dispose();
    }
  },
);

it("failed removal settlement preserves a concurrent full-read failure", async () => {
  const entered = gate<void>();
  const held = gate<void>();
  const read = vi.fn(async () => data);
  const remove = vi.fn<SidebarSectionRemovalMutator>(async () => {
    entered.resolve();
    await held.promise;
    throw new Error("remove offline");
  });
  const store = createSidebarPreferencesStore({
    read,
    available: true,
    removeSection: remove,
  });
  try {
    await store.queries.ensure();
    const removal = store.queries.removeSection("work");
    const rejected = expect(removal).rejects.toThrow("remove offline");
    await entered.promise;
    read.mockRejectedValueOnce(new Error("full read failed"));
    await store.queries.refresh();
    held.resolve();
    await rejected;
    expect(remove).toHaveBeenCalledOnce();
    expect(store.queries.snapshot()).toEqual({
      status: "error",
      error: "full read failed",
      data,
    });
    expect(store.queries.removeSectionWritable).toBe(false);
  } finally {
    held.resolve();
    store.dispose();
  }
});

it.each([true, false])(
  "settles pending section creation before removal (creation succeeds: %s)",
  async (succeeds) => {
    const entered = gate<void>();
    const held = gate<{
      sections: SidebarPreferences["sections"];
      assignments: SidebarPreferences["assignments"];
    }>();
    const created = { id: "new-work", name: "New work", order: 1 };
    const remove = vi.fn<SidebarSectionRemovalMutator>(async () => ({
      sections: data.sections,
      assignments: data.assignments,
    }));
    const store = createSidebarPreferencesStore({
      read: async () => data,
      available: true,
      write: async () => {
        entered.resolve();
        const next = await held.promise;
        if (!succeeds) throw new Error("creation failed");
        return next;
      },
      removeSection: remove,
    });
    try {
      await store.queries.ensure();
      const creating = store.queries.createAndAssign("beta", created);
      await entered.promise;
      expect(store.queries.snapshot().data?.sections).toContainEqual(created);
      const removal = store.queries.removeSection(created.id);
      const creationResult = succeeds
        ? creating
        : expect(creating).rejects.toThrow("creation failed");
      const result = succeeds
        ? expect(removal).resolves.toMatchObject({ sections: data.sections })
        : expect(removal).rejects.toThrow("Sidebar section no longer exists");
      expect(remove).not.toHaveBeenCalled();
      held.resolve({
        sections: [...data.sections, created],
        assignments: { ...data.assignments, beta: created.id },
      });
      await creationResult;
      await result;
      expect(remove).toHaveBeenCalledTimes(succeeds ? 1 : 0);
    } finally {
      held.resolve({
        sections: [...data.sections, created],
        assignments: { ...data.assignments, beta: created.id },
      });
      store.dispose();
    }
  },
);
