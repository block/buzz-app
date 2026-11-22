// Quick voice actions on the hovered message or thread: react, reply, follow
// or unfollow, copy a link, mark unread. Each calls the operation the
// message's own toolbar or menu calls, and is offered only when that control
// would be (`MessageActionBar`, `MessageManagement`). A reaction asks first:
// everyone in the conversation sees it. The rest are private and reversible,
// so they run on their own when the auto-run rule is sure.
import { writeClipboardText } from "../../shared/clipboard";
import { messageCopyLink } from "../messages/message-copy";
import type { ChannelSummary } from "../relay/contracts";
import type { VoiceEntity } from "./voice-actions";
import type { AppVoiceAction, VoiceActionContext } from "./voice-actions-app";
import { resolveMessageRow } from "./voice-actions-message";

type Ctx = VoiceActionContext;

const channelIdOf = (entity: VoiceEntity | undefined) =>
  typeof entity?.meta?.channelId === "string" ? entity.meta.channelId : "";

/** A message's thread root: its own when it starts one. A hovered thread is
 * its root. */
const rootOf = (entity: VoiceEntity) =>
  entity.kind === "message" && typeof entity.meta?.threadRootId === "string"
    ? entity.meta.threadRootId
    : entity.id;

const channelOf = (ctx: Ctx, entity: VoiceEntity | undefined) => {
  const id = channelIdOf(entity);
  return id
    ? ctx.session.channels.list().channels.find((channel) => channel.id === id)
    : undefined;
};

/** A channel the viewer takes part in, as the message menu requires. */
const joined = (channel: ChannelSummary | undefined) =>
  !!channel &&
  !channel.cached &&
  (!channel.readOnly || channel.viewerRole === "guest");

const report = (cause: unknown, fallback: string) =>
  new Error(cause instanceof Error ? cause.message : fallback);

/** Follow and unfollow, on a hovered message or a hovered thread. Only the
 * one that changes anything is offered, and never in a DM, as the menu. */
function followActions(following: boolean): AppVoiceAction[] {
  return (["message", "thread"] as const).map((owner) => ({
    id: following ? `${owner}.follow` : `${owner}.unfollow`,
    owner,
    confirm: "none" as const,
    available: (ctx, { bound }) => {
      const channel = channelOf(ctx, bound);
      if (!bound || !channel || channel.channelType === "dm") return false;
      return (
        ctx.session.unread.following(channel.id, rootOf(bound)) !== following
      );
    },
    // Said as what it changes, notifications, so "open this thread" reads
    // as opening it, not as following it.
    describe: ({ bound }) =>
      following
        ? `Get notified of new replies to ${bound?.label ?? "this message"} (follow its thread)`
        : `Stop notifications for replies to ${bound?.label ?? "this message"} (unfollow its thread)`,
    summary: ({ owner }) =>
      `${following ? "Follow" : "Unfollow"} the thread of ${owner?.label ?? "this message"}`,
    run: async ({ ctx, owner }, env) => {
      if (!owner) throw new Error("No message selected.");
      try {
        ctx.session.unread.follow(channelIdOf(owner), rootOf(owner), following);
      } catch (cause) {
        throw report(cause, "Could not save thread follow. Try again.");
      }
      env.notify(
        following ? "Following this thread" : "Unfollowed this thread",
        "success",
      );
    },
  }));
}

export const quickMessageVoiceActions: readonly AppVoiceAction[] = [
  {
    id: "message.react",
    owner: "message",
    target: "emoji",
    confirm: "confirm",
    available: (ctx, { bound }) => joined(channelOf(ctx, bound)),
    describe: ({ bound }) =>
      `React to ${bound?.label ?? "this message"} with an emoji`,
    summary: ({ owner, target }) =>
      `React ${target?.label ?? "with an emoji"} to ${owner?.label ?? "this message"}`,
    run: async ({ ctx, owner, target }, env) => {
      if (!owner || !target) throw new Error("Choose a message and an emoji.");
      const emoji =
        typeof target.meta?.emoji === "string" ? target.meta.emoji : target.id;
      try {
        ctx.session.messages.react(owner.id, emoji);
      } catch (cause) {
        throw report(cause, "Could not add reaction. Try again.");
      }
      env.notify(`Reacted ${emoji}`, "success");
    },
  },
  {
    id: "message.reply",
    owner: "message",
    confirm: "none",
    available: (ctx, { bound }) => !!ctx.scope && joined(channelOf(ctx, bound)),
    describe: ({ bound }) =>
      `Reply in a thread to ${bound?.label ?? "this message"}`,
    summary: ({ owner }) =>
      `Reply in a thread to ${owner?.label ?? "this message"}`,
    // Opens the thread beside its conversation, as Reply does; what to say
    // is typed there, since a transcript is no message.
    run: async ({ ctx, owner }, env) => {
      if (!owner || !ctx.scope) throw new Error("No message selected.");
      const root = rootOf(owner);
      await env.navigation.open({
        version: 1,
        kind: "conversation",
        scope: ctx.scope,
        channelId: channelIdOf(owner),
        messageId: root,
        threadRootId: root,
      });
    },
  },
  ...followActions(true),
  ...followActions(false),
  {
    id: "message.copy_link",
    owner: "message",
    confirm: "none",
    available: (ctx, { bound }) => !!ctx.session.scope && !!channelIdOf(bound),
    describe: ({ bound }) => `Copy a link to ${bound?.label ?? "this message"}`,
    summary: ({ owner }) => `Copy a link to ${owner?.label ?? "this message"}`,
    run: async ({ ctx, owner }, env) => {
      if (!owner) throw new Error("No message selected.");
      const threadRootId =
        typeof owner.meta?.threadRootId === "string"
          ? owner.meta.threadRootId
          : undefined;
      const row = await resolveMessageRow(
        ctx.session,
        channelIdOf(owner),
        owner.id,
        threadRootId,
      );
      const link = messageCopyLink(row, ctx.session.scope);
      if (!link) throw new Error("This message has no link yet.");
      try {
        await writeClipboardText(link);
      } catch {
        throw new Error("Couldn’t copy. Try again from the message menu.");
      }
      env.notify("Link copied", "success");
    },
  },
  {
    id: "message.mark_unread",
    owner: "message",
    confirm: "none",
    // As the menu: a joined channel's message that isn't unread already.
    // Agent-audience coordination has no read state; its row isn't at hand
    // here, so the unread service refuses it on its own.
    available: (ctx, { bound }) => {
      const channel = channelOf(ctx, bound);
      if (!bound || !joined(channel)) return false;
      const attention = ctx.session.unread.attention(
        channelIdOf(bound),
        bound.id,
      );
      return !attention.unread && !attention.forced;
    },
    describe: ({ bound }) => `Mark ${bound?.label ?? "this message"} as unread`,
    summary: ({ owner }) => `Mark ${owner?.label ?? "this message"} as unread`,
    run: async ({ ctx, owner }, env) => {
      if (!owner) throw new Error("No message selected.");
      try {
        await ctx.session.unread.markMessageUnread(
          channelIdOf(owner),
          owner.id,
        );
      } catch (cause) {
        throw report(cause, "Could not update unread state. Try again.");
      }
      env.notify("Marked unread", "success");
    },
  },
];
