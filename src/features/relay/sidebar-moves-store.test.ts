import { expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarPreferences,
} from "./sidebar-preferences";
import { flush } from "./testing";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup() {
  let data: SidebarPreferences = {
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "work", beta: "work" },
    starred: ["alpha"],
    sort: { channels: "recent" },
  };
  const read = vi.fn(async () => data);
  const assignment = vi.fn(async (intent: SidebarAssignmentIntent) => {
    const id = intent.createSection?.id ?? intent.sectionId;
    const assignments = { ...data.assignments };
    if (id) assignments[intent.channelId] = id;
    else delete assignments[intent.channelId];
    const sections =
      intent.createSection &&
      !data.sections.some(({ id }) => id === intent.createSection?.id)
        ? [...data.sections, { ...intent.createSection, order: 2 }]
        : data.sections;
    data = { ...data, sections, assignments };
    return { sections, assignments };
  });
  const star = vi.fn(
    async (intent: { channelId: string; starred: boolean }) => {
      const stars = new Set(data.starred);
      if (intent.starred) stars.add(intent.channelId);
      else stars.delete(intent.channelId);
      data = { ...data, starred: [...stars] };
      return data.starred;
    },
  );
  const sort = vi.fn(async (key: string) => ({ [key]: "recent" as const }));
  const owner = createSidebarPreferencesStore(
    read,
    true,
    assignment,
    star,
    sort,
  );
  await owner.queries.ensure();
  return { owner, prefs: owner.queries, assignment, star, sort, read };
}

it("moves immediately, keeps later intent through older failure, and serializes both records before sorting", async () => {
  const h = await setup();
  const gate = deferred<readonly string[]>();
  h.star.mockImplementationOnce(() => gate.promise);
  try {
    const first = h.prefs.assign("alpha", "later");
    const failed = expect(first).rejects.toThrow("offline");
    expect(h.prefs.snapshot().data?.assignments.alpha).toBe("later");
    expect(h.prefs.snapshot().data?.starred).toEqual([]);
    await flush(); // assignment confirmed, Star clear held
    expect(h.assignment).toHaveBeenCalledOnce();
    const second = h.prefs.setStar("alpha", true);
    const other = h.prefs.assign("beta", "later");
    const sorting = h.prefs.setSort("forums", "recent", []);
    expect(h.prefs.snapshot().data).toMatchObject({
      assignments: { alpha: "later", beta: "later" },
      starred: ["alpha"],
      sort: { channels: "recent", forums: "recent" },
    });
    expect(h.sort).not.toHaveBeenCalled();
    gate.reject(new Error("offline"));
    await failed;
    await Promise.all([second, other, sorting]);
    expect(h.prefs.snapshot().moves).toBeUndefined(); // stale failure offers no stale retry
    expect(h.prefs.snapshot().data).toMatchObject({
      assignments: { beta: "later" },
      starred: ["alpha"],
      sort: { forums: "recent" },
    });
  } finally {
    gate.resolve([]);
    h.owner.dispose();
  }
});

it("failure rolls back just its channel, persists a retry across refresh, and clears retry after success", async () => {
  const h = await setup();
  h.star.mockRejectedValueOnce(new Error("offline"));
  try {
    const first = h.prefs.assign("alpha", "later");
    const failed = expect(first).rejects.toThrow("offline");
    const other = h.prefs.assign("beta", "later");
    await failed;
    await other;
    expect(h.prefs.snapshot().data?.starred).toEqual(["alpha"]);
    expect(h.prefs.snapshot().data?.assignments.beta).toBe("later");
    expect(h.prefs.snapshot().moves).toEqual([
      expect.objectContaining({
        channelId: "alpha",
        pending: false,
        error: "offline",
      }),
    ]);
    await h.prefs.refresh();
    expect(h.prefs.snapshot().moves).toHaveLength(1);
    const retry = h.prefs.retryMove("alpha");
    expect(h.prefs.snapshot().data?.starred).toEqual([]);
    expect(h.prefs.snapshot().moves?.[0]?.pending).toBe(true);
    await retry;
    expect(h.prefs.snapshot().moves).toBeUndefined();
    expect(h.prefs.snapshot().data?.assignments).toEqual({
      alpha: "later",
      beta: "later",
    });
  } finally {
    h.owner.dispose();
  }
});

it("create-and-move appears before the first write, rolls back on failure, and reuses its ID on retry", async () => {
  const h = await setup();
  const gate = deferred<{
    sections: SidebarPreferences["sections"];
    assignments: SidebarPreferences["assignments"];
  }>();
  h.assignment.mockImplementationOnce(() => gate.promise);
  const section = {
    id: "12345678-1234-1234-1234-123456789abc",
    name: "Launch",
  };
  try {
    const creating = h.prefs.createAndAssign("alpha", section);
    const failed = expect(creating).rejects.toThrow("offline");
    expect(h.prefs.snapshot().data?.sections.at(-1)?.id).toBe(section.id);
    expect(h.prefs.snapshot().data?.assignments.alpha).toBe(section.id);
    expect(h.prefs.snapshot().data?.starred).toEqual([]);
    await flush();
    gate.reject(new Error("offline"));
    await failed;
    expect(h.prefs.snapshot().data?.sections).toHaveLength(2);
    expect(h.prefs.snapshot().data?.starred).toEqual(["alpha"]);
    await h.prefs.retryMove("alpha");
    expect(
      h.assignment.mock.calls.map(([intent]) => intent.createSection?.id),
    ).toEqual([section.id, section.id]);
    expect(h.prefs.snapshot().data?.sections).toHaveLength(3);
  } finally {
    h.owner.dispose();
  }
});

it.each(["clear", "dispose"] as const)(
  "%s clears optimistic placement/errors and rejects late repopulation",
  async (action) => {
    const h = await setup();
    const gate = deferred<readonly string[]>();
    h.star.mockImplementationOnce(() => gate.promise);
    const moving = h.prefs.assign("alpha", "later");
    const failed = expect(moving).rejects.toThrow("unavailable");
    await flush();
    h.owner[action]();
    gate.resolve([]);
    await failed;
    expect(h.prefs.snapshot().data).toBeUndefined();
    expect(h.prefs.snapshot().moves).toBeUndefined();
    h.owner.dispose();
  },
);
