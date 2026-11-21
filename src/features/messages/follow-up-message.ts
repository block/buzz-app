import { resolveForward, type ResolvedForward } from "./resolve-forward";
import type { RelaySession } from "../relay/session";
import type { OutboxRecovery } from "../relay/outbox";
import { ownAgentDm } from "../agents/own-agent-dm";
import { ownSolo } from "../solo/labels";
import { archivedMention } from "./mention-admission";
import { followUpTargets, type FollowUpMessage } from "./follow-up-storage";
import { signMessageTokens } from "./message-tokens";
import { sendWithOwnerMentions } from "../relay/owner-mentions";

/** Recreated after restart; no composer closures or old membership authority. */
export function followUpMessage(
  session: RelaySession,
  message: FollowUpMessage,
  source?: Pick<ResolvedForward, "row" | "name">,
) {
  const targets = followUpTargets(message, session.viewer);
  return {
    ready() {
      const choices = session.agentChoices.snapshot();
      return (
        choices.complete !== false ||
        targets.every((key) =>
          choices.selectable.some((agent) => agent.pubkey === key),
        )
      );
    },
    async beforeRelease() {
      if (message.forward)
        source = await resolveForward(
          session,
          message.forward,
          new AbortController().signal,
        );
      const channel = await session.channelWrites.refreshMembership(
        message.channelId,
      );
      if (message.recipients.some((key) => !channel.members?.includes(key)))
        throw new Error(
          "A queued recipient is no longer a member of this chat.",
        );
      // A DM row is for the owner and their agent alone. Anyone joining, or
      // the agent leaving, leaves it queued with an error; it never sends.
      if (
        message.dmAgent &&
        (channel.members?.length !== 2 ||
          !channel.members.includes(message.dmAgent) ||
          !session.viewer ||
          !channel.members.includes(session.viewer))
      )
        throw new Error(
          "This DM's members changed. Check the chat before sending.",
        );
    },
    publish(recovery?: OutboxRecovery) {
      const channel = session.channels
        .list()
        .channels.find((row) => row.id === message.channelId);
      if (!channel || channel.archived || channel.readOnly)
        throw new Error("This chat is no longer available for sending.");
      const choices = session.agentChoices.snapshot();
      if (message.dmAgent) {
        if (
          !targets.length ||
          ownAgentDm(channel, session.viewer, choices) !== message.dmAgent ||
          targets.some((key) => archivedMention(session, key))
        )
          throw new Error(
            "This DM or its agent is no longer available for queued messages.",
          );
      } else if (
        !targets.length ||
        !ownSolo(channel, session.viewer) ||
        message.recipients.some(
          (key) =>
            archivedMention(session, key) ||
            !choices.selectable.some((agent) => agent.pubkey === key),
        )
      )
        throw new Error(
          "This Solo chat or its recipients are no longer available.",
        );
      // The transport recipient of a DM row is its validated agent, not the
      // profile cache: a cold cache would leave the event without the `p` tag
      // that wakes a hosted agent. Owner-mention evidence stays the typed one.
      const mentions =
        message.dmAgent && !message.recipients.includes(message.dmAgent)
          ? [...message.recipients, message.dmAgent]
          : message.recipients;
      return sendWithOwnerMentions(
        session,
        message.explicitRecipientIds,
        () => {
          if (message.forward) {
            if (!source)
              throw new Error(
                "Reload this forwarded message before sending it.",
              );
            const resolved = source;
            const send = () =>
              session.messages.forward(
                message.channelId,
                resolved.row,
                resolved.name,
                message.text,
                recovery,
                {
                  mentions,
                  attachments: message.attachments,
                  references: message.references,
                  picks: message.picks,
                },
              );
            return message.tokens?.length
              ? signMessageTokens(message.tokens, send)
              : send();
          }
          if (message.tokens?.length)
            return signMessageTokens(message.tokens, () =>
              session.messages.send(
                message.channelId,
                message.text,
                mentions,
                message.attachments,
                recovery,
                message.references,
                message.picks,
              ),
            );
          if (
            !recovery &&
            !message.references.length &&
            !Object.keys(message.picks).length
          )
            return session.messages.send(
              message.channelId,
              message.text,
              mentions,
              message.attachments,
            );
          return session.messages.send(
            message.channelId,
            message.text,
            mentions,
            message.attachments,
            recovery,
            message.references,
            message.picks,
          );
        },
      );
    },
  };
}
