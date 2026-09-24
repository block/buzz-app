import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  coordinate,
  KIT_TAG,
  type Groups,
  type KitRecord,
} from "../channel-templates/model";
import { matchesEvent } from "./projection";
import { keypair, signed } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";

afterEach(() => vi.restoreAllMocks());

const channel = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const community = "https://primary.example";
const groups: Groups = {
  type: "groups",
  id: "personal",
  groups: [
    { id: "work", name: "Personal work", defaultTemplateId: "template" },
  ],
  assignments: { [other]: "work" },
};
function fixture(personal = true) {
  const viewer = keypair(),
    relay = keypair();
  let time = 1_700_000_000;
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  const events: RelayEvent[] = [];
  let legacy: SidebarPreferences = {
    sections: [{ id: "work", name: "OG work", icon: "★", order: 0 }],
    assignments: { [channel]: "work" },
    starred: [],
  muted: [],
  };
  const install = (value: Groups, deleted = false) => {
    const record: KitRecord = { version: 1, community, deleted, value };
    events.push(
      signed(viewer, {
        kind: 30078,
        created_at: time++,
        tags: [
          ["d", coordinate(record)],
          ["t", KIT_TAG],
        ],
        content: JSON.stringify(record),
      }),
    );
  };
  if (personal) install(structuredClone(groups));
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  const assignment = vi.fn(async (intent) => {
    const assignments = { ...legacy.assignments };
    if (intent.sectionId) assignments[intent.channelId] = intent.sectionId;
    else delete assignments[intent.channelId];
    legacy = { ...legacy, assignments };
    return legacy;
  });
  const star = vi.fn(async ({ channelId, starred }) => {
    legacy = { ...legacy, starred: starred ? [channelId] : [] };
    return legacy.starred;
  });
  const publish = vi.fn(async (event: RelayEvent) => {
    events.push(event);
  });
  const prepare = vi.fn(async (record: KitRecord, _signal: AbortSignal) =>
    JSON.stringify(record),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: community,
      media: () => undefined,
      query,
      decodeSidebarPreferences: async () => legacy,
      writeSidebarAssignment: assignment,
      writeSidebarStar: star,
      channelKit: {
        decode: async (rows) =>
          rows.map((event) => ({
            eventId: event.id,
            record: JSON.parse(event.content),
          })),
        prepare,
      },
      writer: {
        kinds: [30078],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  return {
    ...owner,
    query,
    assignment,
    star,
    publish,
    prepare,
    install,
    events,
    preferences: owner.session.sidebarPreferences,
  };
}

it("routes moves/create to opted-in personal groups, preserves defaults and never writes hidden OG groups", async () => {
  const f = fixture();
  try {
    await f.preferences.ensure();
    expect(f.preferences.snapshot().data).toEqual({
      sections: [{ id: "work", name: "Personal work", order: 0 }],
      assignments: { [other]: "work" },
      starred: [],
      groupSource: "personal",
    });
    const move = f.preferences.assign(channel, "work");
    expect(f.preferences.snapshot().data?.assignments[channel]).toBe("work");
    await move;
    await f.preferences.createAndAssign(channel, { id: "new", name: " New " });
    const event = f.publish.mock.calls.at(-1)?.[0];
    if (!event) throw new Error("Missing personal-group publication");
    const saved = JSON.parse(event.content).value;
    expect(saved.groups).toEqual([
      ...groups.groups,
      { id: "new", name: "New", defaultTemplateId: "" },
    ]);
    expect(saved.assignments).toEqual({ [other]: "work", [channel]: "new" });
    expect(f.assignment).not.toHaveBeenCalled();
    await f.preferences.setStar(channel, true);
    expect(f.preferences.snapshot().data?.starred).toEqual([channel]);
    await f.preferences.setStar(channel, false);
    expect(f.preferences.snapshot().data?.assignments[channel]).toBeUndefined();
    expect(f.preferences.snapshot().data?.starred).toEqual([]);
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("retains OG routing before opt-in and refreshes displayed groups after activation and deletion", async () => {
  const f = fixture(false);
  try {
    await f.preferences.ensure();
    await f.preferences.assign(channel);
    expect(f.assignment).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
    f.install(groups);
    await f.session.channelKit.refresh();
    await f.preferences.refresh();
    expect(f.preferences.snapshot().data?.groupSource).toBe("personal");
    f.install(groups, true);
    await f.session.channelKit.refresh();
    await f.preferences.refresh();
    expect(f.preferences.snapshot().data?.groupSource).toBeUndefined();
    expect(f.preferences.snapshot().data?.sections[0]?.icon).toBe("★");
  } finally {
    f.dispose();
  }
});

it("rejects stale-source moves even when group IDs match, then refreshes without silently retrying into the other store", async () => {
  const f = fixture(false);
  try {
    await f.preferences.ensure();
    f.install(groups);
    await expect(f.preferences.assign(channel, "work")).rejects.toThrow(
      /source changed/,
    );
    await f.preferences.refresh();
    expect(f.preferences.snapshot().data?.groupSource).toBe("personal");
    await expect(f.preferences.retryMove(channel)).rejects.toThrow(
      /source changed/,
    );
    expect(f.assignment).not.toHaveBeenCalled();
    expect(f.star).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it.each(["cancel", "clear"] as const)(
  "%s fences an in-progress personal-group preparation before outbox enqueue",
  async (action) => {
    const f = fixture();
    const controller = new AbortController();
    let reached!: (signal: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await f.preferences.ensure();
      f.prepare.mockImplementationOnce(async (record, signal) => {
        reached(signal);
        await gate;
        return JSON.stringify(record);
      });
      const moving = f.preferences.assign(channel, "work", controller.signal);
      const rejected = expect(moving).rejects.toMatchObject({
        name: "AbortError",
      });
      const signal = await entered;
      if (action === "clear") await f.clearCache();
      else controller.abort();
      expect(signal.aborted).toBe(true);
      release();
      await rejected;
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.star).not.toHaveBeenCalled();
      expect(f.session.outbox?.snapshot()).toEqual([]);
    } finally {
      release();
      f.dispose();
    }
  },
);

it("preserves the personal schema limits and restores placement after a failed catalog read or save", async () => {
  const f = fixture();
  try {
    await f.preferences.ensure();
    await expect(
      f.preferences.createAndAssign(channel, {
        id: "new",
        name: "x".repeat(121),
      }),
    ).rejects.toThrow(/recipe text/);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.preferences.snapshot().data?.sections).toHaveLength(1);
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(f.preferences.assign(channel, "work")).rejects.toThrow(
      /offline/,
    );
    expect(f.assignment).not.toHaveBeenCalled();
    expect(f.star).not.toHaveBeenCalled();
    expect(f.preferences.snapshot().data?.assignments[channel]).toBeUndefined();
    await f.preferences.retryMove(channel);
    expect(f.preferences.snapshot().data?.assignments[channel]).toBe("work");
    expect(f.preferences.snapshot().moves).toBeUndefined();
  } finally {
    f.dispose();
  }
});
