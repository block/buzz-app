import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Communities } from "../communities/service";
import type { Navigation } from "../navigation/controller";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { thingToEntity, type VoiceEntity } from "./voice-actions";
import type { AppVoiceAction, VoiceActionEnv } from "./voice-actions-app";
import { quickMessageVoiceActions } from "./voice-actions-message-quick";
import { VOICE_ACTIONS } from "./voice-actions-registry";
import type { VoiceThing } from "./voice-context";

const clipboard = vi.hoisted(() => ({ write: vi.fn(async () => {}) }));
vi.mock("../../shared/clipboard", () => ({
  writeClipboardText: clipboard.write,
}));

const viewer = "f".repeat(64);
const C = "e8552077-d300-4deb-b2e1-cf1e64fe56fa";
const M = "b".repeat(64);
const R = "c".repeat(64);
const scope = { viewer, communityOrigin: "https://relay.example.org" };
const action = (id: string) => {
  const found = quickMessageVoiceActions.find((each) => each.id === id);
  if (!found) throw new Error(`No action ${id}`);
  return found;
};

function harness({
  channelType = "stream",
  following = false,
  unread = false,
  readOnly = false,
}: Partial<{
  channelType: ChannelSummary["channelType"];
  following: boolean;
  unread: boolean;
  readOnly: boolean;
}> = {}) {
  const channel = {
    id: C,
    name: "buzz-relay",
    channelType,
    readOnly,
  } as ChannelSummary;
  const row = {
    id: M,
    channelId: C,
    authorId: "a".repeat(64),
    createdAt: 1,
    content: "deploy finished",
    delivery: "accepted",
  } as ChannelMessage;
  const react = vi.fn();
  const follow = vi.fn();
  const markMessageUnread = vi.fn(async () => ({}));
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const notify = vi.fn();
  const session = {
    viewer,
    scope: `https://relay.example.org:${viewer}`,
    channels: {
      list: () => ({ status: "ready", channels: [channel] }),
      window: () => ({ channelId: C, status: "ready", rows: [row] }),
    },
    messages: { react },
    unread: {
      following: () => following,
      follow,
      attention: () => ({ unread, forced: false }),
      markMessageUnread,
    },
  } as unknown as RelaySession;
  const env: VoiceActionEnv = {
    navigation: { open } as unknown as Navigation,
    communities: {} as Communities,
    notify,
  };
  const ctx = (hovered: VoiceThing) => ({
    session,
    hovered,
    resolveName: (_pk: string, fallback: string) => fallback,
    scope,
  });
  const message: VoiceThing = {
    kind: "message",
    id: M,
    channelId: C,
    authorName: "Jonas",
    label: "message from Jonas",
  };
  const reply: VoiceThing = { ...message, id: R, threadRootId: M };
  const thread: VoiceThing = {
    kind: "thread",
    id: M,
    channelId: C,
    label: "this thread",
  };
  const entity = (thing: VoiceThing) => thingToEntity(thing) as VoiceEntity;
  const available = (id: string, thing: VoiceThing) =>
    action(id).available?.(ctx(thing), {
      hoveredRole: "owner",
      bound: entity(thing),
    }) ?? true;
  const run = (
    id: string,
    thing: VoiceThing,
    target?: VoiceEntity,
  ): ReturnType<AppVoiceAction["run"]> =>
    action(id).run(
      {
        ctx: ctx(thing),
        owner: entity(thing),
        ...(target ? { target } : {}),
        spoken: "",
      },
      env,
    );
  return {
    message,
    reply,
    thread,
    available,
    run,
    react,
    follow,
    markMessageUnread,
    open,
    notify,
  };
}

beforeEach(() => clipboard.write.mockClear());

describe("quick message voice actions", () => {
  it("are registered for the live app", () => {
    const ids = VOICE_ACTIONS.map((each) => each.id);
    for (const each of quickMessageVoiceActions) expect(ids).toContain(each.id);
  });

  it("reacts with the chosen emoji", async () => {
    const h = harness();
    expect(h.available("message.react", h.message)).toBe(true);
    await h.run("message.react", h.message, {
      kind: "emoji",
      id: "👍",
      label: "👍 thumbs up",
      meta: { emoji: "👍" },
    });
    expect(h.react).toHaveBeenCalledWith(M, "👍");
  });

  it("offers no reaction in a channel the viewer can't post in", () => {
    const h = harness({ readOnly: true });
    expect(h.available("message.react", h.message)).toBe(false);
  });

  it("reports a reaction the relay layer refuses", async () => {
    const h = harness();
    h.react.mockImplementation(() => {
      throw new Error("Load the message before reacting to it");
    });
    await expect(
      h.run("message.react", h.message, {
        kind: "emoji",
        id: "👀",
        label: "👀 eyes",
      }),
    ).rejects.toThrow("Load the message before reacting to it");
  });

  it("opens the thread of a message or a reply to reply in", async () => {
    const h = harness();
    await h.run("message.reply", h.message);
    await h.run("message.reply", h.reply);
    expect(h.open).toHaveBeenNthCalledWith(1, {
      version: 1,
      kind: "conversation",
      scope,
      channelId: C,
      messageId: M,
      threadRootId: M,
    });
    expect(h.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadRootId: M }),
    );
  });

  it("offers only the follow change that applies, on messages and threads", () => {
    const off = harness({ following: false });
    expect(off.available("message.follow", off.message)).toBe(true);
    expect(off.available("message.unfollow", off.message)).toBe(false);
    expect(off.available("thread.follow", off.thread)).toBe(true);
    const on = harness({ following: true });
    expect(on.available("message.follow", on.message)).toBe(false);
    expect(on.available("thread.unfollow", on.thread)).toBe(true);
  });

  it("never offers follow in a DM", () => {
    const h = harness({ channelType: "dm" });
    expect(h.available("message.follow", h.message)).toBe(false);
    expect(h.available("thread.follow", h.thread)).toBe(false);
  });

  it("follows a reply's thread by its root", async () => {
    const h = harness();
    await h.run("message.follow", h.reply);
    expect(h.follow).toHaveBeenCalledWith(C, M, true);
    await h.run("thread.unfollow", h.thread);
    expect(h.follow).toHaveBeenLastCalledWith(C, M, false);
  });

  it("copies the message's Buzz link", async () => {
    const h = harness();
    await h.run("message.copy_link", h.message);
    expect(clipboard.write).toHaveBeenCalledWith(
      `buzz://message?channel=${C}&id=${M}`,
    );
    expect(h.notify).toHaveBeenCalledWith("Link copied", "success");
  });

  it("marks a read message unread, and offers nothing for an unread one", async () => {
    const h = harness();
    expect(h.available("message.mark_unread", h.message)).toBe(true);
    await h.run("message.mark_unread", h.message);
    expect(h.markMessageUnread).toHaveBeenCalledWith(C, M);
    const unread = harness({ unread: true });
    expect(unread.available("message.mark_unread", unread.message)).toBe(false);
  });

  it("asks first only for a reaction, which everyone sees", () => {
    for (const each of quickMessageVoiceActions)
      expect(each.confirm, each.id).toBe(
        each.id === "message.react" ? "confirm" : "none",
      );
  });
});
