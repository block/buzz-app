import { afterEach, expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../relay/sidebar-preferences";
import type { RelaySession } from "../relay/session";
import { sectionKey, sectionPreferences } from "./section-preferences";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
function savedStore(name: string) {
  let saved: SidebarPreferences = {
    sections: [{ id: "same-id", name, order: 0 }],
    assignments: {},
    starred: [],
    muted: [],
  };
  const write = vi.fn(
    async (intent: {
      channelId?: string;
      sectionId?: string;
      createSection?: { id: string; name: string };
    }) => {
      const assignments = { ...saved.assignments };
      if (intent.channelId) {
        if (intent.sectionId) assignments[intent.channelId] = intent.sectionId;
        else delete assignments[intent.channelId];
      }
      saved = { ...saved, assignments };
      return saved;
    },
  );
  const owner = createSidebarPreferencesStore({
    available: true,
    read: async () => saved,
    write,
    writeStar: async ({ channelId, starred }) => {
      saved = {
        ...saved,
        starred: [
          ...saved.starred.filter((id) => id !== channelId),
          ...(starred ? [channelId] : []),
        ],
      };
      return saved.starred;
    },
  });
  cleanup.push(owner.dispose);
  return {
    ...owner,
    write,
    saved: () => saved,
    external: (next: Partial<SidebarPreferences>) => {
      saved = { ...saved, ...next };
    },
  };
}
async function fixture() {
  const solo = savedStore("Design");
  const team = savedStore("Design");
  const session = {
    soloPreferences: solo.queries,
    sidebarPreferences: team.queries,
  } as RelaySession;
  const sections = sectionPreferences(session);
  await sections.ensure();
  return { solo, team, sections, session };
}

it("keeps equal IDs distinct and files Solo and Team conversations into either section durably", async () => {
  const f = await fixture();
  expect(
    f.sections.snapshot().data?.sections.map((section) => section.id),
  ).toEqual([sectionKey("solo", "same-id"), sectionKey("team", "same-id")]);
  await f.sections.assign("solo-session", sectionKey("team", "same-id"));
  await f.sections.assign("team-channel", sectionKey("team", "same-id"));
  expect(f.team.saved().assignments).toEqual({
    "solo-session": "same-id",
    "team-channel": "same-id",
  });
  await f.sections.assign("team-channel", sectionKey("solo", "same-id"));
  const reopened = sectionPreferences({ ...f.session });
  await reopened.refresh();
  expect(reopened.snapshot().data?.assignments).toEqual({
    "solo-session": sectionKey("team", "same-id"),
    "team-channel": sectionKey("solo", "same-id"),
  });
});

it("clears fresh source placement and pinning, including edits made after the cached snapshot", async () => {
  const f = await fixture();
  f.team.external({
    assignments: { channel: "same-id" },
    starred: ["channel"],
  });
  await f.sections.assign("channel", sectionKey("solo", "same-id"));
  expect(f.team.saved().assignments).toEqual({});
  expect(f.team.saved().starred).toEqual([]);
  expect(f.solo.saved().assignments.channel).toBe("same-id");
});

it("keeps a confirmed destination after failed cleanup and completes the same move on retry", async () => {
  const f = await fixture();
  await f.sections.assign("channel", sectionKey("solo", "same-id"));
  f.solo.write.mockRejectedValueOnce(new Error("Cleanup failed"));
  await expect(
    f.sections.assign("channel", sectionKey("team", "same-id")),
  ).rejects.toThrow("Cleanup failed");
  expect(f.team.saved().assignments.channel).toBe("same-id");
  expect(f.sections.snapshot().moves?.[0]?.error).toBe("Cleanup failed");
  await f.sections.retryMove("channel");
  expect(f.solo.saved().assignments).toEqual({});
  expect(f.sections.snapshot().data?.assignments.channel).toBe(
    sectionKey("team", "same-id"),
  );
});

it("honors a later pin while a section move is still saving", async () => {
  const f = await fixture();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.solo.write.getMockImplementation();
  if (!write) throw new Error("Missing fixture writer");
  f.solo.write.mockImplementationOnce(async (intent) => {
    started();
    await gate;
    return write(intent);
  });
  const moving = f.sections.assign("channel", sectionKey("solo", "same-id"));
  await entered;
  const pinning = f.sections.setStar("channel", true);
  try {
    expect(f.sections.snapshot().data?.starred).toContain("channel");
  } finally {
    release();
  }
  await Promise.all([moving, pinning]);
  expect(f.team.saved().starred).toContain("channel");
});

it("retires queued moves when the source stores are cleared and refreshed", async () => {
  const f = await fixture();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.solo.write.getMockImplementation();
  if (!write) throw new Error("Missing fixture writer");
  f.solo.write.mockImplementationOnce(async (intent) => {
    started();
    await gate;
    return write(intent);
  });
  const first = f.sections
    .assign("first", sectionKey("solo", "same-id"))
    .catch(() => {});
  await entered;
  const queued = f.sections.assign("second", sectionKey("team", "same-id"));
  const rejected = expect(queued).rejects.toThrow();
  try {
    f.solo.clear();
    f.team.clear();
    await f.sections.refresh();
  } finally {
    release();
  }
  await first;
  await rejected;
  expect(f.team.saved().assignments.second).toBeUndefined();
});

it("keeps a newer move's retry when the previous caller cancels", async () => {
  const f = await fixture();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.solo.write.getMockImplementation();
  if (!write) throw new Error("Missing fixture writer");
  f.solo.write.mockImplementationOnce(async (intent) => {
    started();
    await gate;
    return write(intent);
  });
  const caller = new AbortController();
  const first = f.sections
    .assign("channel", sectionKey("solo", "same-id"), caller.signal)
    .catch(() => {});
  await entered;
  f.team.write.mockRejectedValueOnce(new Error("Destination unavailable"));
  const second = f.sections.assign("channel", sectionKey("team", "same-id"));
  const failed = expect(second).rejects.toThrow("Destination unavailable");
  caller.abort();
  release();
  await Promise.all([first, failed]);
  expect(f.sections.snapshot().moves?.[0]?.error).toBe(
    "Destination unavailable",
  );
  await f.sections.retryMove("channel");
  expect(f.sections.snapshot().data?.assignments.channel).toBe(
    sectionKey("team", "same-id"),
  );
});
