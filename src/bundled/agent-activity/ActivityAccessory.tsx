import { ActivityPopover } from "./ActivityPopover";
import { activityTarget } from "../../features/agents/activity-target";
import { usePresenceStatus } from "../../features/presence/react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { ThreadActivityContext } from "../../features/messages/ThreadActivityContext";
import { useTypingReplacement } from "../../features/conversation/typing-presentation";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import type { RelaySession } from "../../features/relay/session";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { requestActivity } from "./request-activity";
import { activityTranscript } from "./transcript";
import {
  liveAction,
  liveLabel,
  liveTranscript,
  liveReplyVisible,
} from "./live-activity";
import { ActivityStream } from "./ActivityStream";
import { ActivityFeedStatus } from "./ActivityFeedStatus";
import styles from "./ActivityAccessory.module.css";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;

/** One live tail only. Settled messages deliberately have no activity decoration. */
export function ActivityAccessory(props: ComposerAccessoryProps) {
  return props.threadRootId && !props.message ? (
    <LiveActivity {...props} />
  ) : null;
}
function LiveActivity(props: ComposerAccessoryProps) {
  const { session, channelId, threadRootId, request } = props;
  const messageIds = useContext(ThreadActivityContext);
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
    session.agentActivity.snapshot,
  );
  const entries = useMemo(() => {
    const ids = new Set([
      ...messageIds,
      ...(threadRootId ? [threadRootId] : []),
      ...(request ? [request.message.id] : []),
    ]);
    const typing = snapshot.typing.filter(
      (entry) =>
        entry.channelId === channelId && entry.threadRootId === threadRootId,
    );
    const agents = new Set([
      ...typing.map((entry) => entry.agent),
      ...snapshot.turns
        .filter(
          (turn) => turn.channelId === channelId && turn.state !== "ended",
        )
        .map((turn) => turn.agent),
    ]);
    return [...agents].sort().flatMap((agent) => {
      const records = new Map<
        string,
        ReturnType<typeof requestActivity>["records"][number]
      >();
      const turnIds = new Set<string>();
      for (const id of ids) {
        const selected = requestActivity(
          snapshot.records,
          agent,
          channelId,
          id,
        );
        for (const turn of selected.turnIds) turnIds.add(turn);
        for (const record of selected.records) records.set(record.id, record);
      }
      const turns = snapshot.turns.filter(
        (turn) =>
          turn.agent === agent &&
          turn.channelId === channelId &&
          turnIds.has(turn.turnId),
      );
      const live = turns.filter((turn) => turn.state !== "ended");
      const terminalTime = Math.max(
        -Infinity,
        ...turns
          .filter((turn) => turn.state === "ended")
          .map((turn) => turn.timestamp),
      );
      const isTyping = typing.some(
        (entry) => entry.agent === agent && entry.timestamp > terminalTime,
      );
      // A known terminal beats delayed typing for that same observed work.
      if (!live.length && !isTyping) return [];
      const fresh = live.filter((turn) => turn.state === "working");
      // Typing establishes scope, not which unknown turn is doing the work.
      // Never promote an old target back to current just because typing resumed.
      const detailTurns = fresh.length ? fresh : isTyping ? [] : live;
      const selectedRecords = detailTurns.length ? [...records.values()] : [];
      const transcript = liveTranscript(
        activityTranscript(selectedRecords),
        detailTurns,
      );
      return [
        {
          agent,
          replyVisible: liveReplyVisible(transcript, messageIds),
          transcript,
          records: selectedRecords,
          turns: detailTurns,
          working: fresh.length > 0 || isTyping,
        },
      ];
    });
  }, [messageIds, threadRootId, request, snapshot, channelId]);
  const keys = entries.map((entry) => entry.agent).join(":");
  useEffect(() => {
    if (keys)
      void session.profiles
        .ensure(keys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, keys]);
  const profiles = useMemo(
    () => selectProfiles(session.profiles, keys ? keys.split(":") : []),
    [session.profiles, keys],
  );
  const identities = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
  const name = useChannelIdentityNames(session, channelId);
  if (!entries.length) return null;
  return (
    <section
      className={styles.root}
      data-buzz-ui=""
      aria-label="Agent activity in this thread"
    >
      {entries.map((entry) => (
        <LiveEntry
          key={entry.agent}
          {...props}
          {...entry}
          snapshot={snapshot}
          picture={identities.get(entry.agent)?.picture}
          name={name(
            entry.agent,
            identities.get(entry.agent)?.name ??
              `Agent ${entry.agent.slice(0, 8)}`,
          )}
        />
      ))}
    </section>
  );
}
function LiveEntry({
  session,
  channelId,
  threadRootId,
  request,
  agent,
  records,
  transcript,
  turns,
  working,
  snapshot,
  name,
  picture,
  replyVisible,
  canOpen,
  open,
}: ComposerAccessoryProps & {
  agent: string;
  records: ReturnType<typeof requestActivity>["records"];
  turns: Snapshot["turns"];
  transcript: ReturnType<typeof liveTranscript>;
  working: boolean;
  replyVisible: boolean;
  snapshot: Snapshot;
  name: string;
  picture: string | undefined;
}) {
  const panelTarget = activityTarget(agent, channelId);
  const presence = usePresenceStatus(session.presence, agent);
  const displayTranscript = {
    ...transcript,
    groups: transcript.groups.map((group) => ({
      ...group,
      entries: group.entries.map((entry) => {
        const projected = { ...entry };
        // Show the invocation, never duplicate a posted reply as an activity row.
        delete projected.communication;
        if (entry.kind === "tool" || entry.title.startsWith("Permission "))
          projected.title = liveAction(entry);
        return projected;
      }),
    })),
  };
  const label = working
    ? liveLabel(transcript)
    : `${liveLabel(transcript)} · details may be out of date`;
  useTypingReplacement(
    {
      session,
      channelId,
      threadRootId,
      pubkey: agent,
      channelComposer:
        request?.message.id === threadRootId && !request?.message.threadRootId,
    },
    working && snapshot.status === "listening",
  );
  if (replyVisible) return null;
  const details = (
    <>
      <ActivityFeedStatus
        status={snapshot.status}
        trimmed={snapshot.trimmed}
        retry={() => session.live.retry()}
      />
      <ActivityStream
        records={records}
        session={session}
        transcript={displayTranscript}
        turns={turns}
        compact
        showTurnHeading={false}
        showDiagnostics={false}
      />
    </>
  );
  return (
    <div className={styles.line}>
      <Avatar
        shape="squircle"
        alt={`${name} avatar`}
        fallback={name}
        src={picture ? session.media(picture, "small") : undefined}
        statusBadge={presence === "unknown" ? undefined : presence}
      />
      <div className={styles.body}>
        <div className={styles.name}>
          <strong>{name}</strong>
        </div>
        <ActivityPopover
          name={name}
          label={label}
          working={working && snapshot.status === "listening"}
          onExpand={canOpen(panelTarget) ? () => open(panelTarget) : undefined}
        >
          {details}
        </ActivityPopover>
      </div>
    </div>
  );
}
