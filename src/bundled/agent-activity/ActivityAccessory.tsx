import { useTypingReplacement } from "../../features/conversation/typing-presentation";
import { activityTranscript } from "./transcript";
import { workingActivityLabel } from "./activity-presentation";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { RelaySession } from "../../features/relay/session";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { activityTarget } from "../../features/agents/activity-target";
import { activityRecords } from "../../features/agents/activity-records";
import { requestActivity, requestActivityState } from "./request-activity";
import { selectProfiles } from "../../features/relay/profile-selection";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { usePresenceStatus } from "../../features/presence/react";
import { ActivityStream } from "./ActivityStream";
import { ResponseActivity } from "./ResponseActivity";
import { ActivityPopover } from "./ActivityPopover";
import { ActivityFeedStatus } from "./ActivityFeedStatus";
import styles from "./ActivityAccessory.module.css";

/** Plugin activation owns capture. These are ephemeral decorations, never messages. */
export function ActivityAccessory(props: ComposerAccessoryProps) {
  const { session, channelId, threadRootId, message, request } = props;
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
    session.agentActivity.snapshot,
  );
  const typing = snapshot.typing.filter(
    (entry) =>
      entry.channelId === channelId && entry.threadRootId === threadRootId,
  );
  const keys = !threadRootId
    ? ""
    : message
      ? message.agentEnvelope ||
        session.profiles.snapshot().get(message.authorId)?.isAgent ||
        snapshot.records.some(
          (row) =>
            row.agent === message.authorId &&
            row.channelIds.includes(channelId),
        )
        ? message.authorId
        : ""
      : [
          ...new Set(
            request ? request.agents : typing.map((entry) => entry.agent),
          ),
        ]
          .sort()
          .join(":");
  useEffect(() => {
    if (keys && !message)
      void session.profiles
        .ensure(keys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, keys, message]);
  const resolveName = useChannelIdentityNames(session, channelId);
  const profiles = useMemo(
    () => selectProfiles(session.profiles, keys ? keys.split(":") : []),
    [session.profiles, keys],
  );
  const identities = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
  if (!keys) return null;
  const agents = keys.split(":");
  const entries = () =>
    agents.map((agent) => {
      const profile = identities.get(agent);
      return (
        <ActivityEntry
          key={agent}
          {...props}
          agent={agent}
          name={resolveName(
            agent,
            profile?.name ?? `Agent ${agent.slice(0, 8)}`,
          )}
          picture={profile?.picture}
          working={typing.some((entry) => entry.agent === agent)}
          records={snapshot.records}
          turns={snapshot.turns}
          feedStatus={snapshot.status}
          trimmed={snapshot.trimmed}
        />
      );
    });
  return (
    <section
      className={styles.root}
      data-buzz-ui=""
      aria-label={
        message
          ? "Message agent activity"
          : threadRootId
            ? "Agent activity in this thread"
            : "Agent activity in this channel"
      }
    >
      {entries()}
    </section>
  );
}
function ActivityEntry({
  session,
  channelId,
  threadRootId,
  message,
  request,
  canOpen,
  open,
  agent,
  name,
  picture,
  working,
  records: source,
  turns: allTurns,
  feedStatus,
  trimmed,
}: ComposerAccessoryProps & {
  feedStatus: ReturnType<RelaySession["agentActivity"]["snapshot"]>["status"];
  trimmed: number;
  agent: string;
  name: string;
  picture: string | undefined;
  working: boolean;
  records: ReturnType<
    ComposerAccessoryProps["session"]["agentActivity"]["snapshot"]
  >["records"];
  turns: ReturnType<
    ComposerAccessoryProps["session"]["agentActivity"]["snapshot"]
  >["turns"];
}) {
  const presence = usePresenceStatus(
    message ? undefined : session.presence,
    agent,
  );
  const [expanded, expand] = useState<string[]>([]);
  const requestId = request?.message.id;
  const selected = useMemo(
    () =>
      !message && requestId
        ? requestActivity(source, agent, channelId, requestId)
        : undefined,
    [message, requestId, source, agent, channelId],
  );
  const records = useMemo(
    () =>
      message
        ? []
        : (selected?.records ??
          (expanded.length ? activityRecords(source, agent, channelId) : [])),
    [message, selected, expanded.length, source, agent, channelId],
  );
  const turns = useMemo(
    () =>
      allTurns.filter(
        (turn) =>
          turn.agent === agent &&
          turn.channelId === channelId &&
          (!selected || selected.turnIds.has(turn.turnId)),
      ),
    [allTurns, agent, channelId, selected],
  );
  const transcript = useMemo(() => activityTranscript(records), [records]);
  const requestState = selected
    ? requestActivityState(selected, turns, trimmed)
    : undefined;
  const requestWorking = selected ? requestState === "working" : working;
  const [menu, setMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  const pointer = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const expandedPanel = useRef(false);
  const target = activityTarget(
    agent,
    channelId,
    message?.id,
    message ? undefined : requestId,
  );
  function detach() {
    region.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
    if (canOpen(target) && open(target)) {
      expandedPanel.current = true;
      expand([]);
    }
    setMenu(false);
  }
  const delivery = request?.message.delivery;
  const label = message
    ? "View activity"
    : delivery === "failed"
      ? "Request not sent"
      : delivery === "sending"
        ? "Sending request…"
        : delivery === "unknown"
          ? "Delivery unconfirmed"
          : requestWorking
            ? selected
              ? workingActivityLabel(transcript, turns)
              : "Working…"
            : requestState === "unknown"
              ? "Status unknown"
              : requestState === "error"
                ? "Observed activity ended · error reported"
                : requestState === "ended"
                  ? "Observed activity ended"
                  : "Waiting for response…";
  const replacesTyping =
    !message &&
    requestWorking &&
    feedStatus === "listening" &&
    (!delivery || delivery === "accepted" || delivery === "seen");
  useTypingReplacement(
    {
      session,
      channelId,
      threadRootId,
      pubkey: agent,
      channelComposer:
        !!request &&
        request.message.id === threadRootId &&
        !request.message.threadRootId,
    },
    replacesTyping,
  );
  return (
    <div className={message ? styles.attached : styles.response} ref={region}>
      {!message && (
        <Avatar
          src={picture ? session.media(picture) : undefined}
          alt=""
          fallback={name}
          shape="squircle"
          statusBadge={presence === "unknown" ? undefined : presence}
          size="large"
        />
      )}
      <div className={styles.body}>
        {!message && <p className="text-label-sm">{name}</p>}
        {!message && (
          <span
            className="sr-only"
            role="status"
            aria-label="Agent activity status"
          >
            {replacesTyping
              ? `${name} is working. ${label}`
              : `${name}: ${label}`}
          </span>
        )}
        <ContextMenu.Root open={menu} onOpenChange={setMenu}>
          <ContextMenu.Trigger
            className={styles.disclosure}
            onKeyDown={(event) => {
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                event.stopPropagation();
                setMenu(true);
              }
            }}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                (event.target !== event.currentTarget.querySelector("button") &&
                  !(
                    event.target instanceof Element &&
                    event.currentTarget
                      .querySelector("button")
                      ?.contains(event.target)
                  ))
              )
                return;
              pointer.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                moved: false,
              };
              suppressClick.current = false;
            }}
            onPointerMove={(event) => {
              const start = pointer.current;
              if (!event.buttons) {
                pointer.current = null;
                setDragging(false);
                return;
              }
              if (!start || start.id !== event.pointerId || !canOpen(target))
                return;
              if (
                event.clientX - start.x > 60 &&
                Math.abs(event.clientY - start.y) < 100
              ) {
                event.currentTarget.setPointerCapture(event.pointerId);
                start.moved = true;
                setDragging(true);
                suppressClick.current = true;
              }
            }}
            onPointerUp={(event) => {
              const start = pointer.current;
              pointer.current = null;
              setDragging(false);
              if (start?.moved && event.clientX - start.x > 60) {
                event.preventDefault();
                detach();
              }
            }}
            onLostPointerCapture={() => {
              pointer.current = null;
              setDragging(false);
            }}
            onPointerLeave={() => {
              if (!pointer.current?.moved) pointer.current = null;
            }}
            onPointerCancel={() => {
              pointer.current = null;
              setDragging(false);
            }}
            onClickCapture={(event) => {
              if (suppressClick.current) {
                event.preventDefault();
                event.stopPropagation();
                suppressClick.current = false;
              }
            }}
          >
            <ActivityPopover
              name={name}
              label={label}
              working={replacesTyping}
              open={expanded.length > 0}
              onOpenChange={(value) => {
                if (value) expandedPanel.current = false;
                expand(value ? ["activity"] : []);
              }}
              finalFocus={() => !expandedPanel.current}
              onExpand={canOpen(target) ? detach : undefined}
            >
              <ActivityFeedStatus
                status={feedStatus}
                trimmed={trimmed}
                retry={() => session.live.retry()}
              />
              {source.some((row) => row.saveError) && (
                <p role="status" className="text-body-sm text-subtle">
                  Some live Activity could not be saved. Saved history may have
                  gaps.
                </p>
              )}
              {message ? (
                feedStatus !== "unavailable" && (
                  <ResponseActivity
                    records={source}
                    session={session}
                    agent={agent}
                    channelId={channelId}
                    messageId={message.id}
                  />
                )
              ) : (
                <div className={styles.details}>
                  {!selected && (
                    <p className="text-body-sm text-subtle">
                      Channel activity, including other threads
                    </p>
                  )}
                  {feedStatus === "listening" && !records.length && (
                    <p className="text-body-sm text-subtle">
                      No activity received yet. The request does not confirm the
                      agent has started.
                    </p>
                  )}
                  <ActivityStream
                    records={records}
                    session={session}
                    transcript={transcript}
                    turns={turns}
                    compact
                    showTurnHeading={false}
                    showDiagnostics={false}
                  />
                </div>
              )}
            </ActivityPopover>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner>
              <ContextMenu.Popup data-buzz-ui="" className={styles.menu}>
                <ContextMenu.Item
                  className={styles.menuItem}
                  disabled={!canOpen(target)}
                  onClick={detach}
                >
                  Open activity in side panel
                </ContextMenu.Item>
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.Root>
        {dragging && (
          <span className={styles.dragHint} role="status">
            Release to open activity beside the conversation
          </span>
        )}
      </div>
    </div>
  );
}
