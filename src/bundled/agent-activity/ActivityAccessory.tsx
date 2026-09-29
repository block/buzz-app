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
import { elapsedWork } from "./request-work";
import { cachedRequestWork } from "./request-work-cache";
import {
  conversationReplies,
  isAgentCoordination,
} from "../../features/messages/conversation-visibility";
import styles from "./ActivityAccessory.module.css";

/** Request overview or work attached to a real reply, never a synthetic message. */
export function ActivityAccessory(props: ComposerAccessoryProps) {
  return (props.workRequest || props.message) && props.threadRootId ? (
    <WorkHeader {...props} />
  ) : null;
}
function WorkHeader(props: ComposerAccessoryProps) {
  const { session, channelId, threadRootId, message, canOpen, open } = props;
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
  const rows = useMemo(
    () =>
      props.threadMessages ??
      (loaded?.root ? [loaded.root, ...loaded.replies] : []),
    [props.threadMessages, loaded],
  );
  const projection = useMemo(
    () =>
      cachedRequestWork(
        snapshot,
        loaded ?? rows,
        channelId,
        threadRootId ?? "",
        session.viewer,
      ),
    [snapshot, loaded, rows, channelId, threadRootId, session.viewer],
  );
  const fullWork = projection.find((work) =>
    message
      ? work.agents.some(
          (agent) =>
            agent.agent === message.authorId &&
            agent.responseIds.includes(message.id),
        )
      : work.requestId === props.workRequest?.id,
  );
  const workRequest =
    props.workRequest ?? rows.find((row) => row.id === fullWork?.requestId);
  const hidden = new Set(
    rows
      .filter((row) => isAgentCoordination(row, known, session.viewer))
      .map((row) => row.id),
  );
  const visible = conversationReplies(rows, hidden, threadRootId);
  const replies = new Map(
    fullWork?.agents.map((agent) => [
      agent.agent,
      visible.filter(
        (row) => agent.responseIds.includes(row.id) && !row.membership,
      ),
    ]),
  );
  // Every strictly linked visible reply offers the same request-scoped work.
  // Only direct root children are guaranteed mounted: nested-only work retains
  // the overview without borrowing the host's branch-expansion state.
  const attached = (key: string) =>
    replies
      .get(key)
      ?.some(
        (row) => row.id !== threadRootId && row.replyParentId === threadRootId,
      );
  const [expanded, setExpanded] = useState(false);
  const displayed =
    fullWork?.agents.filter((agent) =>
      message
        ? agent.agent === message.authorId &&
          replies.get(agent.agent)?.some((row) => row.id === message.id)
        : !attached(agent.agent) ||
          (expanded && fullWork.agents.every((item) => attached(item.agent))),
    ) ?? [];
  const state = displayed.some((agent) => agent.state === "working")
    ? "working"
    : displayed.some((agent) => agent.state === "error")
      ? "error"
      : fullWork?.uncertain ||
          displayed.some((agent) => agent.state === "unknown")
        ? "unknown"
        : displayed.length
          ? "ended"
          : "waiting";
  const work = fullWork && { ...fullWork, agents: displayed, state };
  const keys = [
    ...new Set([
      ...(fullWork?.agents.map((agent) => agent.agent) ?? []),
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
  const remainingKeys = keys.filter((key) => !attached(key));
  const displayNames = linkedNames.length
    ? linkedNames
    : remainingKeys.map((key) => names.get(key) ?? "Agent");
  const title = new Intl.ListFormat(undefined, {
    style: "long",
    type: "conjunction",
  }).format(displayNames);
  const panelOpened = useRef(false);
  const [selectedAgent, setSelectedAgent] = useState("");
  if (
    !workRequest ||
    !work ||
    !fullWork ||
    !keys.length ||
    (message && !displayed.length) ||
    (!message && !remainingKeys.length && !expanded)
  )
    return null;
  const delivery = workRequest.delivery;
  const healthy = snapshot.status === "listening";
  const complete =
    props.threadComplete ??
    (loaded?.status === "ready" &&
      !loaded.canLoadMore &&
      !loaded.limited &&
      !loaded.error);
  const elapsed =
    work.agents.length === fullWork.agents.length
      ? fullWork.elapsed
      : work.agents.length === 1
        ? work.agents[0]?.elapsed
        : undefined;
  const duration =
    complete && healthy && !work.uncertain && elapsed !== undefined
      ? elapsedWork(elapsed)
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
  const namedLabel =
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
  const label = message
    ? namedLabel
        .replace(`${title} worked`, "Worked")
        .replace(`${title} is working…`, "Working…")
    : namedLabel;
  const first =
    fullWork.agents.find((agent) => agent.agent === selectedAgent)?.agent ??
    message?.authorId ??
    work.agents[0]?.agent ??
    keys[0];
  const target = activityTarget(
    first ?? "",
    channelId,
    undefined,
    workRequest.id,
    threadRootId,
  );
  return (
    <section
      className={message ? styles.attached : styles.root}
      data-buzz-ui=""
      aria-label={
        message ? "Agent work on this request" : "Work linked to this request"
      }
    >
      {work.agents
        .filter((agent) => healthy && agent.state === "working")
        .map((agent) => (
          <TypingReplacement key={agent.agent} {...props} agent={agent.agent} />
        ))}
      {!message && (
        <span className={styles.avatars} aria-hidden="true">
          {(work.agents.length
            ? work.agents.map((agent) => agent.agent)
            : remainingKeys
          )
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
      )}
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
        <RequestWorkDetails
          work={fullWork}
          session={session}
          names={names}
          selectedAgent={first}
          onAgentChange={setSelectedAgent}
        />
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
