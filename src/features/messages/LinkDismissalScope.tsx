import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { useKnownAgentPubkeys } from "../agents/use-known";
import {
  LinkDismissContext,
  type LinkDismissal,
} from "../conversation/LinkLabelContext";
import { useAgentOwnerEvidence } from "../profiles/useAgentOwnerEvidence";
import type { ChannelMessage } from "../relay/contracts";
import { useListedChannel } from "../relay/listed-channel";
import { useRowProfiles } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { angleLink, linkAt } from "./link-forms";
import { parseMediaTimeReply } from "./media-timecode";
import { validateMessageEdit } from "./message-edit";
import { httpsUrl } from "./preview-links";
import { lastEditableMessage } from "./useMessageEdit";

const sourceOf = (row: ChannelMessage) => row.sourceContent ?? row.content;
const hasLink = (content: string) => /\w:\/\/|www\./i.test(content);

/** What a message row draws as its text, as `MessageRow` projects it. */
function drawnText(row: ChannelMessage, content: string) {
  const reply = row.diff ? undefined : parseMediaTimeReply(content);
  return reply?.content ?? content;
}

/** Messages whose dismissal is being sent, across the scopes of its body and cards. */
const sending = new Set<string>();
const noEvents: readonly never[] = [];
const noSnapshot = () => noEvents;
const noSubscribe = () => () => {};

/** Lets the link renderers and preview cards of a message rewrite one of its
 * links to angle brackets, as an ordinary edit, when the viewer may edit the
 * message: its author, or the verified owner of the agent that wrote it. `row`
 * is the complete message, whatever part of it the children draw. */
export function LinkDismissalScope({
  row,
  session,
  children,
}: {
  row: ChannelMessage;
  session: RelaySession | undefined;
  children: ReactNode;
}) {
  if (!session?.viewer || !hasLink(sourceOf(row))) return children;
  return (
    <Dismissable row={row} session={session}>
      {children}
    </Dismissable>
  );
}

function Dismissable({
  row,
  session,
  children,
}: {
  row: ChannelMessage;
  session: RelaySession;
  children: ReactNode;
}) {
  const own = row.authorId === session.viewer;
  const writable = useListedChannel(
    session.channels,
    row.channelId,
    (channel) =>
      !!channel && !channel.readOnly && !channel.cached && !channel.archived,
  );
  const profiles = useRowProfiles(session.profiles, [row]);
  const agentHinted = useKnownAgentPubkeys(session, profiles).has(row.authorId);
  const ownership = useAgentOwnerEvidence(
    session,
    own || !agentHinted ? undefined : row.authorId,
  );
  const current = useRef(row);
  current.current = row;
  useSyncExternalStore(
    session.outbox?.subscribe ?? noSubscribe,
    session.outbox?.snapshot ?? noSnapshot,
    session.outbox?.snapshot ?? noSnapshot,
  );
  const owner =
    !own &&
    !!session.viewer &&
    ownership.status === "ready" &&
    ownership.owner === session.viewer;
  const dismiss =
    writable &&
    (own || owner) &&
    lastEditableMessage(session, [row], row.authorId)
      ? async (link: LinkDismissal) => {
          if (sending.has(row.id))
            throw new Error("Wait for the previous change to finish.");
          sending.add(row.id);
          try {
            const rewrite = () => {
              const latest = current.current;
              if (!lastEditableMessage(session, [latest], latest.authorId))
                throw new Error("This message can’t be edited right now.");
              const base = sourceOf(latest);
              const target =
                "at" in link
                  ? linkAt(
                      drawnText(latest, latest.content),
                      link.at,
                      (url) => httpsUrl(url) === link.url,
                    )
                  : link;
              const next = target && angleLink(base, target);
              if (!next) throw new Error("This link can’t be changed here.");
              validateMessageEdit(latest, base, next);
              return {
                content: next,
                attachmentSourceId: latest.attachmentSourceId ?? latest.id,
              };
            };
            if (own) {
              const { content, attachmentSourceId } = rewrite();
              session.messages.edit(row.id, content, attachmentSourceId);
            } else await session.messages.editOwnedAgent(row.id, rewrite);
          } finally {
            sending.delete(row.id);
          }
        }
      : undefined;
  return <LinkDismissContext value={dismiss}>{children}</LinkDismissContext>;
}
