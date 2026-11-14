import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { validChannelLabel } from "../relay/channel-labels";
import { eligibleSolo, ownSolo } from "../solo/labels";
import { readDefaultLifetime } from "../solo/default-lifetime";
import { readView, writeView } from "../../shared/view-state";
import { messageCopyLink } from "./message-copy";
import type { ComposerToken } from "./composer-token";
import { signMessageTokens } from "./message-tokens";

/** A question for an agent that can't reply where it was written (Viewing
 * only, or not in the channel), asked in your Solo chat with it instead. */
export type SoloAsk = {
  agent: { pubkey: string; name: string };
  question: string;
  channelId: string;
  channelName: string;
  threadRootId?: string | undefined;
  /** The question's chips, signed with it as an ordinary send signs them. */
  tokens?: readonly ComposerToken[] | undefined;
};

/** Lowercase words joined by single hyphens, with no `#`, spaces or marks. */
function slug(value: string, fallback: string, limit: number) {
  const words = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, limit)
    .replace(/^-+|-+$/g, "");
  return words || fallback;
}

/** The chat's name, following channel naming: `<channel>-ask-<agent>`,
 * e.g. `buzz-team-ask-bestie`. Only a label: asks find the chat by its agent
 * and source channel, so a rename or two agents with one name don't matter. */
export function soloAskName(channelName: string, agentName: string) {
  return `${slug(channelName, "channel", 56)}-ask-${slug(agentName, "agent", 56)}`;
}

/** The chat's About line, with a link to the source channel. */
export function soloAskAbout(
  ask: Pick<SoloAsk, "agent" | "channelId" | "channelName">,
) {
  return `Questions for ${ask.agent.name} from #${ask.channelName}: ${channelLink(ask.channelId)}`;
}

const channelLink = (id: string) => `buzz://channel/${encodeURIComponent(id)}`;

/** The source channel, recorded on the chat itself so any device finds it. */
const askLabel = (channelId: string) => {
  const label = `buzz.ask:${channelId}`;
  return validChannelLabel(label) ? label : undefined;
};
/** A source channel id a label can't hold is remembered on this device only
 * (for the account and community: the view scope). */
const askKey = (agent: string, channelId: string) =>
  `solo:ask:${agent}:${channelId}`;

/** Only you and `agent` can read it: confirmed private, or still starting
 * on this device (always private), with no one else in it. Sharing a Solo
 * chat keeps its labels, so a shared one is left for a new chat. */
function privateWith(chat: ChannelSummary, viewer: string, agent: string) {
  const members = chat.members ?? [];
  return (
    (chat.pending ||
      (chat.visibility === "private" &&
        !chat.metadataCached &&
        !chat.cached)) &&
    members.length === 2 &&
    members.includes(viewer) &&
    members.includes(agent)
  );
}

/** Your Solo chat with `agent` for asks from `channelId`: one you started,
 * still open and private to the two of you, that records this source
 * channel. */
export function soloAskChat(
  session: Pick<RelaySession, "channels" | "viewer" | "scope">,
  agent: string,
  channelId: string,
): ChannelSummary | undefined {
  const viewer = session.viewer;
  if (!viewer) return;
  const label = askLabel(channelId);
  const saved = label
    ? undefined
    : readView<unknown>(session.scope, askKey(agent, channelId), null);
  return session.channels
    .list()
    .channels.filter(
      (chat) =>
        eligibleSolo(chat, viewer) &&
        ownSolo(chat, viewer) &&
        privateWith(chat, viewer, agent) &&
        (label ? !!chat.labels?.includes(label) : chat.id === saved),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

/** The ask's message: the question, then where it came from. The link renders
 * as the channel or message it names, so the name isn't repeated. */
export function soloAskMessage(
  ask: SoloAsk,
  scope: string,
): string | undefined {
  const link = ask.threadRootId
    ? messageCopyLink(
        {
          // The root itself, opened as its thread.
          id: ask.threadRootId,
          channelId: ask.channelId,
          threadRootId: ask.threadRootId,
        } as ChannelMessage,
        scope,
      )
    : channelLink(ask.channelId);
  if (!link) return;
  return `${ask.question}\n\n(${
    ask.threadRootId
      ? `Asked from a thread you can’t reply in: ${link}`
      : `Asked from ${link}, where you can’t reply.`
  })`;
}

/**
 * Asks `ask.agent` in your Solo chat with it for this channel: the one an
 * earlier ask from here started, or a new one when that chat is gone,
 * archived, or no longer private to you and the agent. Each chat is one conversation, so
 * later asks from the same channel continue it. Returns the chat's id and
 * `ready`, which rejects with `ChatNotStarted` when the relay never made the
 * chat: then the chat and the question are withdrawn (see
 * `channelWrites.start`). Throws, without creating or sending, when nothing
 * can be asked.
 */
export function askInSolo(
  session: Pick<
    RelaySession,
    "channels" | "channelWrites" | "messages" | "viewer" | "scope"
  >,
  ask: SoloAsk,
): { channelId: string; reused: boolean; ready: Promise<void> } {
  if (!session.viewer || !session.channelWrites.available)
    throw new Error(
      "Solo chats are unavailable right now. Your draft is kept.",
    );
  const text = soloAskMessage(ask, session.scope);
  if (!text)
    throw new Error("This thread can’t be linked yet. Your draft is kept.");
  const existing = soloAskChat(session, ask.agent.pubkey, ask.channelId);
  const channelId = existing?.id ?? crypto.randomUUID();
  // A chat an earlier ask is still starting can still be refused.
  let ready =
    (existing && session.channelWrites.starting(existing.id)) ||
    Promise.resolve();
  if (!existing) {
    const label = askLabel(ask.channelId);
    if (
      !label &&
      !writeView(
        session.scope,
        askKey(ask.agent.pubkey, ask.channelId),
        channelId,
      )
    )
      throw new Error(
        "This chat couldn’t be saved on this device. Your draft is kept.",
      );
    // The chat lists at once and the question goes out behind its create.
    ({ ready } = session.channelWrites.start(
      channelId,
      soloAskName(ask.channelName, ask.agent.name),
      [ask.agent.pubkey],
      readDefaultLifetime(session.scope),
      // Named on purpose, so a first-message title never replaces it.
      true,
      undefined,
      { ...(label ? { labels: [label] } : {}), about: soloAskAbout(ask) },
    ));
  }
  signMessageTokens(ask.tokens ?? [], () =>
    session.messages.send(channelId, text, [ask.agent.pubkey]),
  );
  return { channelId, reused: !!existing, ready };
}
