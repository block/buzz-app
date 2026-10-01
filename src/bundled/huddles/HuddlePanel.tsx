import type { ConversationExtensions } from "../../features/conversation/contracts";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { useEffect, useState } from "react";
import type { PanelProps } from "../../features/panels/service";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import {
  createHuddleDiscussion,
  type HuddleDiscussion,
} from "../../features/huddle/discussion";
import { HuddleDiscussionView } from "./HuddleDiscussionView";
import { parseHuddleTarget } from "./HuddleCard";

export function HuddlePanel({
  target,
  channelContext,
  relay,
  extensions,
}: PanelProps & {
  relay: RelayData;
  extensions?: ConversationExtensions | undefined;
}) {
  const connection = useRelayConnection(relay);
  const parsed = parseHuddleTarget(target);
  const room = parsed?.room;
  const parent = parsed?.parent;
  const [owner, setOwner] =
    useState<ReturnType<typeof createHuddleDiscussion>>();
  const [discussion, setDiscussion] = useState<HuddleDiscussion>();
  const valid =
    connection.status === "ready" &&
    !!room &&
    (!channelContext ||
      (channelContext.scope === connection.scope &&
        channelContext.channelId === parsed?.parent));
  useEffect(() => {
    setOwner(undefined);
    setDiscussion(undefined);
    if (!valid || !room || !parent) return;
    const next = createHuddleDiscussion(connection.session, room, parent, () =>
      setDiscussion(next.snapshot()),
    );
    setOwner(next);
    setDiscussion(next.snapshot());
    return () => next.dispose();
  }, [valid, room, parent, connection.session]);
  return valid && room && owner && discussion ? (
    <HuddleDiscussionView
      discussion={discussion}
      composer={
        <MessageComposer
          session={connection.session}
          extensions={extensions}
          scope={connection.scope ?? ""}
          channelId={room}
          channelName="Huddle"
          label="Message this Huddle"
          placeholder="Message this Huddle"
          disabled={!discussion.writable}
        />
      }
      older={owner.older}
      retry={owner.retry}
      recover={owner.recover}
    />
  ) : (
    <p className="p-4 text-secondary">
      {valid
        ? "Loading conversation…"
        : "This Huddle conversation is unavailable."}
    </p>
  );
}
