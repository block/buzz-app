import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, metadata, roster, signed } from "./testing";
import type { LiveCallbacks } from "./live";
import type {
  ActivityHistory,
  SavedActivity,
} from "../agents/activity-history";
import type { HeadPersistence } from "./persistence";

it("keeps history omitted by cached discovery, reveals it only after signed channel resolution, and purges on explicit cache clear", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const event = signed(agent, {
    kind: 24200,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", viewer.pubkey],
      ["agent", agent.pubkey],
      ["frame", "telemetry"],
    ],
    content: "encrypted-fixture",
  });
  let saved: SavedActivity[] = [{ event, receivedAt: Date.now() }];
  const storage: ActivityHistory = {
    load: vi.fn(async () => saved),
    append: vi.fn(async () => {}),
    clear: vi.fn(async () => {
      saved = [];
    }),
    close: vi.fn(),
  };
  const discovery = [
    roster(relay, "alpha", [viewer.pubkey]),
    metadata(relay, "alpha", "Alpha"),
  ];
  const persistence: HeadPersistence = {
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: discovery,
      },
    }),
    writeStartup: async () => {},
    read: async () => [],
    write: async () => {},
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.example",
      media: () => undefined,
      query: async (filters) =>
        filters.some((filter) => filter.kinds?.includes(39002))
          ? discovery.filter((event) => event.kind === 39002)
          : filters.some((filter) => filter.kinds?.includes(39000))
            ? discovery.filter((event) => event.kind === 39000)
            : [],
      agentActivity: true,
      decodeActivityHistory: async (events) =>
        events.map((event) => ({
          id: event.id,
          agent: event.pubkey,
          createdAt: event.created_at,
          plaintext: JSON.stringify({
            kind: "turn_liveness",
            turnId: "saved",
            channelId: "omitted",
            timestamp: new Date().toISOString(),
          }),
        })),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {}, observe() {} };
      },
    },
    { persistence, prepared: true, activityHistoryStorage: storage },
  );
  try {
    await owner.restore();
    owner.session.agentActivity.activate();
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().history).toBe("ready"),
    );
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    expect(saved).toHaveLength(1);
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    expect(saved).toHaveLength(1);
    live.receive([
      roster(relay, "omitted", [viewer.pubkey]),
      metadata(relay, "omitted", "Recovered channel"),
    ]);
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().records).toHaveLength(1),
    );
    expect(owner.session.agentActivity.snapshot().turns).toEqual([]);
    live.receive([
      roster(relay, "omitted", [], Math.floor(Date.now() / 1000) + 1),
    ]);
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().history).toBe("ready"),
    );
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(storage.clear).not.toHaveBeenCalled();
    await owner.clearCache();
    expect(saved).toEqual([]);
    expect(storage.clear).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});
