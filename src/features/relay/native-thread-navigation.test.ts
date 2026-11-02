import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { finalizeEvent, nip44 } from "nostr-tools";
import { nativeThreadNavigation } from "./native-thread-navigation";
import {
  createThreadNavigation,
  parseThreadRecord,
  threadNavigationTags,
  type ThreadRecord,
} from "../channel-navigation/recent-threads";
import { keypair } from "./testing";
import { eventDto, type RelayEvent } from "./events";
import type { ChannelMessage } from "./contracts";
import type { ReadTransport } from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const root = (id: string, content: string): ChannelMessage => ({
  id: id.repeat(64),
  channelId: "general",
  authorId: "b".repeat(64),
  content,
  createdAt: 1,
  replyCount: 0,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
});
const idle = (store: ReturnType<typeof createThreadNavigation>) =>
  new Promise<void>((resolve) => {
    if (!store.snapshot().pending.length) return resolve();
    const stop = store.subscribe(() => {
      if (!store.snapshot().pending.length) {
        stop();
        resolve();
      }
    });
  });
function fixture() {
  const viewer = keypair();
  const key = nip44.v2.utils.getConversationKey(viewer.secret, viewer.pubkey);
  const saved = new Map<string, RelayEvent>();
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command === "relay_sign_sidebar") {
      const { coordinate, payload, createdAt } = input as {
        coordinate: string;
        payload: ThreadRecord;
        createdAt: number;
      };
      return finalizeEvent(
        {
          kind: 30078,
          created_at: createdAt,
          content: nip44.v2.encrypt(JSON.stringify(payload), key),
          tags: [
            ["d", coordinate],
            ["t", threadNavigationTags[payload.type]],
          ],
        },
        viewer.secret,
      );
    }
    if (command === "relay_decode_sidebar") {
      const { events } = input as { events: RelayEvent[] };
      return Object.fromEntries(
        events.map((event) => [
          event.tags.find(([tag]) => tag === "d")?.[1],
          JSON.parse(nip44.v2.decrypt(event.content, key)),
        ]),
      );
    }
    throw new Error(`Unexpected ${command}`);
  });
  const transport: ReadTransport = {
    media: () => undefined,
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    query: vi.fn<ReadTransport["query"]>(async (filters) => [
      ...new Map(
        filters.flatMap((filter) =>
          [...saved.entries()]
            .filter(
              ([coordinate, event]) =>
                (!filter["#d"] || filter["#d"].includes(coordinate)) &&
                (!filter["#t"] ||
                  event.tags.some(
                    ([tag, value]) =>
                      tag === "t" && filter["#t"]?.includes(value ?? ""),
                  )),
            )
            .map(([, event]) => [event.id, event] as const),
        ),
      ).values(),
    ]),
    writer: {
      sign: async () => {
        throw new Error("General signing must not be used");
      },
      publish: async (input) => {
        const event = eventDto(input);
        const coordinate = event.tags.find(([tag]) => tag === "d")?.[1];
        if (!coordinate) throw new Error("Missing coordinate");
        saved.set(coordinate, event);
      },
    },
  };
  const host = nativeThreadNavigation(transport);
  return { host, saved, viewer, key, transport };
}

it("syncs visits and pins between two sessions without a visit overwriting a pin choice", async () => {
  let time = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => ++time);
  const { host, saved } = fixture();
  const lifetime = new AbortController();
  const a = createThreadNavigation(host, lifetime.signal);
  const b = createThreadNavigation(host, lifetime.signal);
  try {
    a.visit(root("a", "First thread"));
    b.visit(root("b", "Second thread"));
    await Promise.all([idle(a), idle(b)]);
    await a.refresh();
    expect(a.snapshot().entries.map((entry) => entry.title)).toEqual([
      "Second thread",
      "First thread",
    ]);
    const first = a
      .snapshot()
      .entries.find((entry) => entry.rootId === "a".repeat(64));
    if (!first) throw new Error("Missing first thread");
    a.pin(first, true);
    await idle(a);
    await b.refresh();
    expect(
      b.snapshot().entries.find((entry) => entry.rootId === first.rootId)
        ?.pinned,
    ).toBeGreaterThan(0);
    a.visit(root("a", "First thread"));
    b.pin(first, false);
    await Promise.all([idle(a), idle(b)]);
    await a.refresh();
    expect(a.snapshot().entries[0]).toMatchObject({
      rootId: first.rootId,
      visitedAt: expect.any(Number),
    });
    expect(a.snapshot().entries[0]?.pinned).toBeUndefined();
    expect(saved.size).toBe(3);
    for (const event of saved.values()) {
      expect(event.content).not.toContain("First thread");
      expect(event.tags.flat().join()).not.toContain("general");
    }
    const restored = createThreadNavigation(host, lifetime.signal);
    await restored.refresh();
    expect(restored.snapshot().entries).toEqual(a.snapshot().entries);
    restored.dispose();
  } finally {
    lifetime.abort();
    a.dispose();
    b.dispose();
  }
});

it("rejects malformed intent and signed records bound to another thread", async () => {
  const { host, saved, viewer, key } = fixture();
  const input = {
    version: 1,
    type: "visit",
    channelId: "general",
    rootId: "a".repeat(64),
    title: "Planning",
    at: 1,
  } as const;
  expect(() =>
    parseThreadRecord({ ...input, extra: "arbitrary data" }),
  ).toThrow("Invalid thread navigation");
  await host.write(input, new AbortController().signal);
  const event = [...saved.values()][0];
  if (!event) throw new Error("Missing signed record");
  const forged = finalizeEvent(
    {
      ...event,
      content: nip44.v2.encrypt(
        JSON.stringify({ ...input, rootId: "b".repeat(64) }),
        key,
      ),
    },
    viewer.secret,
  );
  saved.set(event.tags[0]?.[1] ?? "", forged);
  await expect(host.read(new AbortController().signal)).rejects.toThrow(
    "Invalid thread navigation binding",
  );
});

it("dates a retry publication now while preserving when the thread was actually visited", async () => {
  const { host, saved } = fixture();
  const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    const input = {
      version: 1,
      type: "visit",
      channelId: "general",
      rootId: "a".repeat(64),
      title: "Earlier visit",
      at: Date.now() - 3_600_000,
    } as const;
    const result = await host.write(input, new AbortController().signal);
    expect(result.at).toBe(input.at);
    expect([...saved.values()][0]?.created_at).toBe(
      Math.floor(Date.now() / 1000),
    );
  } finally {
    now.mockRestore();
  }
});
