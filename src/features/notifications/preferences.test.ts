import { expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parsePreferences,
  createNotificationPreferences,
} from "./preferences";

const stored = {
  enabled: true,
  notifyWhileViewing: false,
  sound: true,
  categories: { mention: true, direct: true, thread: false },
};

it("values saved before per-category sounds restore with the defaults", () => {
  expect(parsePreferences(stored).sounds).toEqual(
    DEFAULT_NOTIFICATION_PREFERENCES.sounds,
  );
});

it.each([
  { mention: "ping", direct: "unison", thread: "doop", agent: "doodone" },
  {
    mention: "silent",
    direct: "silent",
    thread: "silent",
    agent: "silent",
  },
])(
  "saved sound choices round-trip and unknown names reject the payload: %j",
  (sounds) => {
    expect(
      parsePreferences(JSON.parse(JSON.stringify({ ...stored, sounds })))
        .sounds,
    ).toEqual(sounds);
    expect(() => parsePreferences({ ...stored, sounds: "ping" })).toThrow(
      "Invalid notification sounds",
    );
    expect(() =>
      parsePreferences({ ...stored, sounds: { mention: "klaxon" } }),
    ).toThrow("Invalid notification sounds");
  },
);

it("validates and isolates quiet conversation preferences while restoring older settings", () => {
  const saved = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    quietConversations: [
      { communityOrigin: "wss://EXAMPLE.test/", channelId: "solo-123" },
    ],
  };
  expect(parsePreferences(saved).quietConversations).toEqual([
    { communityOrigin: "https://example.test", channelId: "solo-123" },
  ]);
  for (const quietConversations of [
    null,
    {},
    [{ communityOrigin: "https://example.test/path", channelId: "chat" }],
    [{ communityOrigin: "https://example.test", channelId: "../chat" }],
  ])
    expect(() => parsePreferences({ ...saved, quietConversations })).toThrow();
});

function storageFixture(values = new Map<string, string>()) {
  let changed: ((event: StorageEvent) => void) | undefined;
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const host = {
    localStorage: storage,
    addEventListener: (_type: string, listener: typeof changed) => {
      changed = listener;
    },
    removeEventListener: () => {
      changed = undefined;
    },
  } as unknown as Window;
  return {
    values,
    storage,
    preferences: createNotificationPreferences(host),
    changed: (key: string) =>
      changed?.({ key, storageArea: storage } as StorageEvent),
  };
}
const viewer = "a".repeat(64);
const chat = { communityOrigin: "https://community.test", channelId: "chat" };
const mainKey = `buzz-notification-preferences.v1:${viewer}`;
const chatKey = `buzz-notification-preferences.v1:sound:${viewer}:${JSON.stringify([chat.communityOrigin, chat.channelId])}`;

it("retains legacy silence and durable default overrides through Settings saves and viewer changes", () => {
  const t = storageFixture(
    new Map([
      [mainKey, JSON.stringify({ ...stored, quietConversations: [chat] })],
    ]),
  );
  const p = t.preferences;
  p.selectViewer(viewer);
  expect(p.snapshot().preferences.quietConversations).toEqual([chat]);
  expect(p.setConversationSound(chat, "default")).toBe(true);
  p.update({ sound: false });
  p.reload();
  expect(p.snapshot().preferences.quietConversations).toEqual([]);
  p.setConversationSound(chat, "silent");
  p.selectViewer("b".repeat(64));
  expect(p.snapshot().preferences.quietConversations).toEqual([]);
  p.selectViewer(viewer);
  expect(p.snapshot().preferences.quietConversations).toEqual([chat]);
  p.dispose();
});

it("preserves unsaved off and silent intent through remote events, and retries both on Save", () => {
  const t = storageFixture();
  const p = t.preferences;
  p.selectViewer(viewer);
  const write = t.storage.setItem;
  t.storage.setItem = () => {
    throw new Error("Disk full");
  };
  expect(p.update({ enabled: false })).toBe(false);
  t.changed(mainKey);
  expect(p.snapshot().preferences.enabled).toBe(false);
  t.storage.setItem = write;
  expect(p.update({})).toBe(true);
  t.storage.setItem = () => {
    throw new Error("Disk full");
  };
  expect(p.setConversationSound(chat, "silent")).toBe(false);
  t.values.set(chatKey, "default");
  t.changed(chatKey);
  expect(p.snapshot().preferences.quietConversations).toEqual([chat]);
  expect(p.snapshot().error).toBeTruthy();
  t.storage.setItem = write;
  expect(p.update({})).toBe(true);
  p.reload();
  expect(p.snapshot().preferences.enabled).toBe(false);
  expect(p.snapshot().preferences.quietConversations).toEqual([chat]);
  expect(p.snapshot().error).toBeNull();
  p.dispose();
});

it("refreshes sound changes from another window without changing unrelated chats", () => {
  const t = storageFixture();
  const p = t.preferences;
  p.selectViewer(viewer);
  t.values.set(chatKey, "silent");
  t.changed(chatKey);
  expect(p.snapshot().preferences.quietConversations).toEqual([chat]);
  t.values.set(chatKey, "default");
  t.changed(chatKey);
  expect(p.snapshot().preferences.quietConversations).toEqual([]);
  p.dispose();
});

it("reconciles remote silent chats when an unsaved choice is successfully retried", () => {
  const t = storageFixture();
  const p = t.preferences;
  p.selectViewer(viewer);
  const write = t.storage.setItem;
  t.storage.setItem = () => {
    throw new Error("Disk full");
  };
  expect(p.setConversationSound(chat, "silent")).toBe(false);
  const remote = { ...chat, channelId: "remote-chat" };
  const remoteKey = `buzz-notification-preferences.v1:sound:${viewer}:${JSON.stringify([remote.communityOrigin, remote.channelId])}`;
  t.values.set(remoteKey, "silent");
  t.changed(remoteKey);
  t.storage.setItem = write;
  expect(p.update({})).toBe(true);
  expect(p.snapshot().preferences.quietConversations).toEqual(
    expect.arrayContaining([chat, remote]),
  );
  p.dispose();
});

it("does not carry legacy silence into another viewer after a failed restore", () => {
  const t = storageFixture(
    new Map([
      [mainKey, JSON.stringify({ ...stored, quietConversations: [chat] })],
    ]),
  );
  const p = t.preferences;
  p.selectViewer(viewer);
  const nextViewer = "b".repeat(64);
  t.values.set(
    `buzz-notification-preferences.v1:${nextViewer}`,
    "invalid JSON",
  );
  p.selectViewer(nextViewer);
  expect(p.snapshot().error).toBeTruthy();
  expect(p.update({})).toBe(true);
  expect(p.snapshot().preferences.quietConversations).toEqual([]);
  expect(
    JSON.parse(
      t.values.get(`buzz-notification-preferences.v1:${nextViewer}`) ?? "null",
    ).quietConversations,
  ).toBeUndefined();
  p.selectViewer(viewer);
  expect(p.snapshot().preferences.quietConversations).toEqual([chat]);
  p.dispose();
});
