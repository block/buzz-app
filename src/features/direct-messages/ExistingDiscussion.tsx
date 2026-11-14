import { useLayoutEffect, useRef, useState } from "react";
import { useChannelWindow } from "../relay/react";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import {
  ConversationChannel,
  ConversationTimeline,
} from "../conversation/Conversation";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import type { ConversationExtensions } from "../conversation/contracts";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./NewMessage.module.css";

/** History owns paging and loading; the draft and send journal stay mounted above. */
export function ExistingDiscussion({
  session,
  scope,
  channel,
  extensions,
  host,
  onOpen,
  onRecovered,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions?: ConversationExtensions | undefined;
  host: ConversationHostServices;
  onOpen(messageId: string, threadRootId: string, intent?: "reply"): void;
  onRecovered(): void;
}) {
  const window = useChannelWindow(session.channels, channel.id);
  const retry = useRef<HTMLButtonElement>(null);
  const [recovering, setRecovering] = useState(false);
  const waiting = !window.rows.length && window.status !== "ready";
  useLayoutEffect(() => {
    if (waiting || !recovering) return;
    // Hand off before removing Retry, and only while it still owns focus.
    if (document.activeElement === retry.current) onRecovered();
    setRecovering(false);
  }, [waiting, recovering, onRecovered]);
  if (waiting || recovering)
    return (
      <div
        className={styles.feedback}
        role={window.status === "error" ? "alert" : "status"}
      >
        <p>{window.status === "error" ? window.error : "Loading messages…"}</p>
        {(window.status === "error" || recovering) && (
          <Button
            ref={retry}
            type="button"
            loading={window.status !== "error"}
            onClick={() => {
              setRecovering(true);
              session.channels.ensure(channel.id);
            }}
          >
            Retry messages
          </Button>
        )}
      </div>
    );
  return (
    <ConversationChannel
      session={session}
      scope={scope}
      channel={channel}
      extensions={extensions}
      active={false}
      host={host}
    >
      <ConversationTimeline
        window={window}
        transient
        marksRead={false}
        onOpenThread={onOpen}
      />
    </ConversationChannel>
  );
}
