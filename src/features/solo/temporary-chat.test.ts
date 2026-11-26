// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { UNLISTED_LABEL } from "../relay/channel-labels";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../relay/channel-writes";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import { writeDefaultLifetime } from "./default-lifetime";
import {
  TEMPORARY_LABELS,
  findTemporaryChat,
  hiddenFromSearch,
  startTemporaryChat,
  temporaryAbout,
  temporarySource,
} from "./temporary-chat";
import { SOLO_LABEL } from "./labels";

afterEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
});

const viewer = "a".repeat(64);
const agent = "e".repeat(64);
const source = "11111111-1111-4111-8111-111111111111";
const scope = `https://relay.example:${viewer}`;
const message = {
  id: "b".repeat(64),
  channelId: source,
  threadRootId: "c".repeat(64),
  content: "Where did we land on launch?",
} as ChannelMessage;

const makeChat = (
  id: string,
  about: string,
  extra: Partial<ChannelSummary> = {},
) =>
  ({
    id,
    name: id,
    members: [viewer],
    channelType: "solo",
    creator: viewer,
    unlisted: true,
    labels: [SOLO_LABEL, ...TEMPORARY_LABELS],
    description: about,
    ...extra,
  }) as ChannelSummary;

it("names its source in the saved about, prefers open chats and falls back to archived ones", () => {
  const about = temporaryAbout(message, scope);
  expect(temporarySource(about)).toMatchObject({
    channelId: source,
    messageId: message.id,
    rootId: message.threadRootId,
  });
  expect(
    temporarySource("Temporary chat about something else"),
  ).toBeUndefined();
  expect(
    findTemporaryChat(
      [
        makeChat("older", about, { createdAt: 1 }),
        makeChat("newer", about, { createdAt: 2 }),
        makeChat("archived", about, { createdAt: 3, archived: true }),
        makeChat("shared", about, { createdAt: 4, creator: "d".repeat(64) }),
      ],
      viewer,
      message.id,
    )?.id,
  ).toBe("newer");
  // When only archived chats remain, the newest archived one stays reachable.
  expect(
    findTemporaryChat(
      [
        makeChat("archived-old", about, { createdAt: 1, archived: true }),
        makeChat("archived-new", about, { createdAt: 5, archived: true }),
        makeChat("shared", about, { createdAt: 9, creator: "d".repeat(64) }),
      ],
      viewer,
      message.id,
    )?.id,
  ).toBe("archived-new");
});

it("keeps own temporary chats searchable while hiding other unlisted channels", () => {
  const about = temporaryAbout(message, scope);
  const ownTemp = makeChat("temp", about);
  const archivedTemp = makeChat("temp-old", about, { archived: true });
  const otherTemp = makeChat("other", about, { creator: "d".repeat(64) });
  const huddle = {
    id: "huddle",
    name: "Huddle",
    members: [viewer],
    channelType: "stream",
    unlisted: true,
    huddle: true,
    labels: [UNLISTED_LABEL],
  } as ChannelSummary;
  expect(hiddenFromSearch(ownTemp, viewer)).toBe(false);
  expect(hiddenFromSearch(archivedTemp, viewer)).toBe(false);
  expect(hiddenFromSearch(otherTemp, viewer)).toBe(true);
  expect(hiddenFromSearch(huddle, viewer)).toBe(true);
});

it("uses the configured Solo temporary lifetime (or 7 days) and waits for the opening forward", async () => {
  const listeners = new Set<() => void>();
  let entry: OutgoingEvent = {
    event: { id: "f".repeat(64) } as OutgoingEvent["event"],
    delivery: "sending",
  };
  const start = vi.fn(() => ({ ready: Promise.resolve() }));
  const forward = vi.fn(() => entry.event.id);
  const session = {
    viewer,
    scope,
    channelWrites: { start },
    messages: { forward },
    outbox: {
      snapshot: () => [entry],
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;

  // Without a saved Solo lifetime, falls back to 7 days and reports a failed forward.
  const pending = startTemporaryChat(session, message, agent, "Alice");
  await Promise.resolve();
  await Promise.resolve();
  entry = { ...entry, delivery: "failed", error: "Relay refused forward." };
  for (const listener of listeners) listener();
  const failed = await pending;
  expect(start).toHaveBeenLastCalledWith(
    failed.chatId,
    expect.stringMatching(/^About: Where did we land/),
    [agent],
    DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
    false,
    undefined,
    expect.objectContaining({ labels: TEMPORARY_LABELS }),
  );
  expect(failed.forwardError).toBe("Relay refused forward.");

  // With a saved Solo lifetime (e.g. 14 days), uses it and settles cleanly on accepted delivery.
  if (typeof localStorage !== "undefined") {
    writeDefaultLifetime(scope, 14 * 24 * 60 * 60);
    entry = {
      event: { id: "0".repeat(64) } as OutgoingEvent["event"],
      delivery: "accepted",
    };
    const ok = await startTemporaryChat(session, message, agent, "Alice");
    expect(start).toHaveBeenLastCalledWith(
      ok.chatId,
      expect.any(String),
      [agent],
      14 * 24 * 60 * 60,
      false,
      undefined,
      expect.objectContaining({ labels: TEMPORARY_LABELS }),
    );
    expect(ok.forwardError).toBeUndefined();
  }
});
