import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { activityTarget } from "../../features/agents/activity-target";
import { useTypingReplacement } from "../../features/conversation/typing-presentation";
import { useLoadedThread } from "../../features/messages/thread-views";
import { ActivityPopover } from "./ActivityPopover";
import { ActivityFeedStatus } from "./ActivityFeedStatus";
import { RequestWorkDetails } from "./RequestWorkDetails";
import { requestWork, elapsedWork } from "./request-work";
import styles from "./ActivityAccessory.module.css";

/** One request-anchored work header, never a synthetic reply or a thread-wide rollup. */
export function ActivityAccessory(props: ComposerAccessoryProps) {
  return props.workRequest && props.threadRootId && !props.message ? (
    <WorkHeader {...props} />
  ) : null;
}
function WorkHeader(props: ComposerAccessoryProps) {
  const {
    session,
    channelId,
    threadRootId,
    workRequest,
    threadComplete,
    canOpen,
    open,
  } = props;
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const known = useKnownAgentPubkeys(session, profiles);
  const loaded = useLoadedThread(session, channelId, threadRootId ?? "");
  const projection = useMemo(
    () =>
      requestWork(
        snapshot,
        props.threadMessages ??
          (loaded?.root ? [loaded.root, ...loaded.replies] : []),
        channelId,
        threadRootId ?? "",
        session.viewer,
      ),
    [
      snapshot,
      props.threadMessages,
      loaded,
      channelId,
      threadRootId,
      session.viewer,
    ],
  );
  const work = projection.find((work) => work.requestId === workRequest?.id);
  const keys = [
    ...new Set([
      ...(work?.agents.map((agent) => agent.agent) ?? []),
      ...(workRequest?.mentions.filter((key) => known.has(key)) ?? []),
    ]),
  ].sort();
  const resolveName = useChannelIdentityNames(session, channelId);
  const suffix = publicKeyLabels(keys);
  const names = new Map(
    keys.map((key) => [
      key,
      resolveName(key, profiles.get(key)?.name ?? suffix.get(key) ?? "Agent"),
    ]),
  );
  // Exact-key labels remain distinct even when optional naming data is incomplete.
  const labels = [...names.values()];
  for (const [key, label] of names)
    if (labels.filter((value) => value === label).length > 1)
      names.set(key, `${label} · ${suffix.get(key)}`);
  const linkedNames =
    work?.agents.map((agent) => names.get(agent.agent) ?? "Agent") ?? [];
  const displayNames = linkedNames.length
    ? linkedNames
    : keys.map((key) => names.get(key) ?? "Agent");
  const title = new Intl.ListFormat(undefined, {
    style: "long",
    type: "conjunction",
  }).format(displayNames);
  const [expanded, setExpanded] = useState(false);
  const panelOpened = useRef(false);
  if (!workRequest || !work || !keys.length) return null;
  const delivery = workRequest.delivery;
  const healthy = snapshot.status === "listening";
  const duration =
    threadComplete && healthy && work.elapsed !== undefined
      ? elapsedWork(work.elapsed)
      : undefined;
  const namedState = (state: string) =>
    new Intl.ListFormat(undefined, {
      style: "long",
      type: "conjunction",
    }).format(
      work.agents
        .filter((agent) => agent.state === state)
        .map((agent) => names.get(agent.agent) ?? "Agent"),
    );
  const workingAgents = work.agents.filter(
    (agent) => agent.state === "working",
  );
  const label =
    delivery === "sending"
      ? "Sending request…"
      : delivery === "failed"
        ? "Request not sent"
        : delivery === "unknown"
          ? "Delivery unconfirmed"
          : !healthy
            ? `${title} · work status unknown`
            : work.state === "working"
              ? `${namedState("working")} ${workingAgents.length === 1 ? "is" : "are"} working…`
              : work.state === "error"
                ? `${namedState("error")} · error reported`
                : work.state === "unknown"
                  ? `${title} · work status unknown`
                  : work.agents.length
                    ? `${title} worked${duration ? ` for ${duration}` : " on this request"}`
                    : `${title} · awaiting activity`;
  const first = work.agents[0]?.agent ?? keys[0];
  const target = activityTarget(
    first ?? "",
    channelId,
    undefined,
    workRequest.id,
    threadRootId,
  );
  return (
    <section
      className={styles.root}
      data-buzz-ui=""
      aria-label="Work linked to this request"
    >
      {work.agents
        .filter((agent) => healthy && agent.state === "working")
        .map((agent) => (
          <TypingReplacement key={agent.agent} {...props} agent={agent.agent} />
        ))}
      <span className={styles.avatars} aria-hidden="true">
        {(work.agents.length ? work.agents.map((agent) => agent.agent) : keys)
          .slice(0, 3)
          .map((key) => (
            <Avatar
              key={key}
              size="small"
              shape="squircle"
              alt=""
              fallback={names.get(key) ?? "Agent"}
              src={
                profiles.get(key)?.picture
                  ? session.media(profiles.get(key)?.picture ?? "")
                  : undefined
              }
            />
          ))}
      </span>
      <ActivityPopover
        name="Request activity"
        label={label}
        working={healthy && work.state === "working"}
        open={expanded}
        onOpenChange={(value) => {
          if (value) panelOpened.current = false;
          setExpanded(value);
        }}
        finalFocus={() => !panelOpened.current}
        onExpand={
          canOpen(target)
            ? () => {
                if (open(target)) {
                  panelOpened.current = true;
                  setExpanded(false);
                }
              }
            : undefined
        }
      >
        <ActivityFeedStatus
          status={snapshot.status}
          trimmed={snapshot.trimmed}
          retry={() => session.live.retry()}
        />
        <RequestWorkDetails work={work} session={session} names={names} />
        {duration && (
          <p className="text-caption text-subtle">
            Local capture span across linked turns, including overlap and gaps.
          </p>
        )}
      </ActivityPopover>
    </section>
  );
}
function TypingReplacement({
  session,
  channelId,
  threadRootId,
  agent,
}: ComposerAccessoryProps & { agent: string }) {
  useTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent, channelComposer: false },
    true,
  );
  return null;
}
