// Built-in Milestone 1 message & thread voice actions.
import { canMessageAgent } from "../agents/choices";
import { linkedMessage } from "../conversation/linked-message";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import { snapshotMessage } from "../relay/forwarded-message";
import type { RelaySession } from "../relay/session";
import {
  isWritableChannelDestination,
  type AppVoiceAction,
} from "./voice-actions-app";
import type { VoiceEntity } from "./voice-actions";

const FORWARD_RECOVERY_KEY = "message:forward";

function messageIdsFromEntity(owner: VoiceEntity): {
  messageId: string;
  channelId: string;
  threadRootId?: string | undefined;
} {
  const channelId =
    typeof owner.meta?.channelId === "string" ? owner.meta.channelId : "";
  const threadRootId =
    typeof owner.meta?.threadRootId === "string"
      ? owner.meta.threadRootId
      : undefined;
  return { messageId: owner.id, channelId, threadRootId };
}

export async function resolveMessageRow(
  session: RelaySession,
  channelId: string,
  messageId: string,
  threadRootId?: string,
): Promise<ChannelMessage> {
  const inWindow = session.channels
    .window(channelId)
    .rows.find((row) => row.id === messageId);
  if (inWindow) return inWindow;

  const lookupId = threadRootId || messageId;
  const view = session.thread(channelId, lookupId, {
    exact: true,
    priority: "foreground",
  });
  return new Promise<ChannelMessage>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out loading this message."));
    }, 6_000);
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      view.dispose();
    };
    const check = () => {
      if (settled) return;
      const snap = view.snapshot();
      const fromThread =
        snap.root?.id === messageId
          ? snap.root
          : (snap.replies.find((row) => row.id === messageId) ??
            linkedMessage(snap, messageId).message);
      if (fromThread) {
        settled = true;
        cleanup();
        resolve(fromThread);
        return;
      }
      const state = linkedMessage(snap, messageId);
      if (state.stopped) {
        settled = true;
        cleanup();
        reject(
          new Error(
            "Couldn’t load this message. It may have been deleted or become unavailable.",
          ),
        );
      }
    };
    const unsubscribe = view.subscribe(check);
    check();
    void view.refresh();
  });
}

async function forwardResolvedMessage({
  session,
  sourceChannelId,
  messageId,
  threadRootId,
  resolveName,
  destChannelId,
  people,
  channel,
  destinationLabel,
  scope,
  navigation,
  notify,
}: {
  session: RelaySession;
  sourceChannelId: string;
  messageId: string;
  threadRootId?: string | undefined;
  resolveName: (
    pubkey: string,
    fallback: string,
    among?: readonly string[],
  ) => string;
  destChannelId: string;
  people: readonly { pubkey: string; name: string; isAgent?: boolean }[];
  channel?: { id: string; name: string } | undefined;
  destinationLabel: string;
  scope: Parameters<AppVoiceAction["run"]>[0]["ctx"]["scope"];
  navigation: Parameters<AppVoiceAction["run"]>[1]["navigation"];
  notify: Parameters<AppVoiceAction["run"]>[1]["notify"];
}) {
  const row = await resolveMessageRow(
    session,
    sourceChannelId,
    messageId,
    threadRootId,
  );
  const profiles = session.profiles.snapshot();
  const authorId = row.workflowOwnerId ?? row.authorId;
  const authorName = resolveName(
    authorId,
    profiles.get(authorId)?.name ?? authorId.slice(0, 10),
  );
  const agents = session.agentChoices.snapshot().identities;
  const snapshot = snapshotMessage(row, authorName, profiles, agents);
  const forwardRow = {
    ...row,
    mentionLabels: snapshot.mentionLabels ?? [],
  };
  const problem = session.messages.forwardProblem?.(
    destChannelId,
    forwardRow,
    authorName,
    "",
  );
  if (problem) throw new Error(problem);

  const controller = new AbortController();
  const sentId = session.messages.forward(
    destChannelId,
    forwardRow,
    authorName,
    "",
    {
      key: FORWARD_RECOVERY_KEY,
      value: JSON.stringify({
        source: { channelId: sourceChannelId, forward: messageId },
        people,
        ...(channel ? { channel } : {}),
        note: "",
      }),
    },
  );
  await session.directMessages.delivered(
    sentId,
    destChannelId,
    controller.signal,
  );
  await session.outbox?.acknowledge(sentId);

  notify(
    `Message forwarded to ${destinationLabel}`,
    "success",
    scope
      ? {
          label: `Open ${destinationLabel}`,
          onClick: () => {
            void navigation.open({
              version: 1,
              kind: "conversation",
              scope,
              channelId: destChannelId,
              messageId: sentId,
            });
          },
        }
      : undefined,
  );
}

export const messageVoiceActions: readonly AppVoiceAction[] = [
  {
    id: "message.forward_to_person",
    owner: "message",
    target: "person",
    confirm: "confirm",
    available: (ctx, { bound }) =>
      !!bound &&
      !!bound.meta?.channelId &&
      ctx.session.directMessages.available,
    describe: ({ bound }) =>
      `Forward ${bound?.label ?? "this message"} to a person or agent (DM)`,
    summary: ({ owner, target }) =>
      `Forward ${owner?.label ?? "message"} to ${target?.label ?? "person"}`,
    run: async ({ ctx, owner, target }, env) => {
      if (!owner || !target) {
        throw new Error("Choose a message and a recipient.");
      }
      const { messageId, channelId, threadRootId } =
        messageIdsFromEntity(owner);
      if (!channelId) throw new Error("Source channel is unavailable.");

      const profiles = ctx.session.profiles.snapshot();
      const profile = profiles.get(target.id);
      const isAgent = Boolean(target.meta?.isAgent || profile?.isAgent);
      if (isAgent) {
        const usable = ctx.session.agentChoices
          .snapshot()
          .identities.some(
            (choice) => choice.pubkey === target.id && canMessageAgent(choice),
          );
        if (!usable) {
          throw new Error(
            `${target.label} is not available for direct messages.`,
          );
        }
      }

      const controller = new AbortController();
      const dmChannelId = await ctx.session.directMessages.open(
        [target.id],
        controller.signal,
      );
      const recipient = {
        pubkey: target.id,
        name: target.label,
        ...(isAgent ? { isAgent: true } : {}),
      };
      await forwardResolvedMessage({
        session: ctx.session,
        sourceChannelId: channelId,
        messageId,
        threadRootId,
        resolveName: ctx.resolveName,
        destChannelId: dmChannelId,
        people: [recipient],
        destinationLabel: target.label,
        scope: ctx.scope,
        navigation: env.navigation,
        notify: env.notify,
      });
    },
  },
  {
    id: "message.forward_to_channel",
    owner: "message",
    target: "channel",
    confirm: "confirm",
    available: (ctx, { bound }) =>
      !!bound &&
      !!bound.meta?.channelId &&
      ctx.session.directMessages.available,
    filterSlot: (slot, candidate) => {
      if (slot !== "channel") return true;
      const summary = candidate.meta?.channel as ChannelSummary | undefined;
      return summary ? isWritableChannelDestination(summary) : false;
    },
    describe: ({ bound }) =>
      `Forward ${bound?.label ?? "this message"} to a channel`,
    summary: ({ owner, target }) =>
      `Forward ${owner?.label ?? "message"} to ${target?.label ?? "channel"}`,
    run: async ({ ctx, owner, target }, env) => {
      if (!owner || !target) {
        throw new Error("Choose a message and a destination channel.");
      }
      const { messageId, channelId, threadRootId } =
        messageIdsFromEntity(owner);
      if (!channelId) throw new Error("Source channel is unavailable.");

      const dest =
        (target.meta?.channel as ChannelSummary | undefined) ??
        ctx.session.channels
          .list()
          .channels.find((channel) => channel.id === target.id);
      if (!dest || !isWritableChannelDestination(dest)) {
        throw new Error(
          `You cannot post in ${target.label}. Choose another destination.`,
        );
      }

      await forwardResolvedMessage({
        session: ctx.session,
        sourceChannelId: channelId,
        messageId,
        threadRootId,
        resolveName: ctx.resolveName,
        destChannelId: dest.id,
        people: [],
        channel: { id: dest.id, name: dest.name },
        destinationLabel: `#${dest.name}`,
        scope: ctx.scope,
        navigation: env.navigation,
        notify: env.notify,
      });
    },
  },
];
