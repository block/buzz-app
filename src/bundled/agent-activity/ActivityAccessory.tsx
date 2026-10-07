import { useChannelIdentityNames } from "../../features/identity-names/react";
import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  DotsThreeIcon,
  QuestionIcon,
} from "../../shared/design-system/icons/index";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { activityTarget } from "../../features/agents/activity-target";
import { selectProfiles } from "../../features/relay/profile-selection";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { usePresenceStatus } from "../../features/presence/react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import styles from "./ActivityAccessory.module.css";

/** Capture is leased by plugin activation, never by an individual composer. */
export function ActivityAccessory({
  session,
  channelId,
  threadRootId,
  canOpen,
  open,
}: ComposerAccessoryProps) {
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
    session.agentActivity.snapshot,
  );
  const turns = snapshot.turns.filter(
    (turn) =>
      !threadRootId && turn.channelId === channelId && turn.state !== "ended",
  );
  // TypingIndicator suppresses this same exact-scope, canOpen-filtered set in
  // composers. Keep its projection synchronized when changing row eligibility.
  const typing = snapshot.typing.filter(
    (entry) =>
      entry.channelId === channelId && entry.threadRootId === threadRootId,
  );
  const keys = [...new Set([...turns, ...typing].map((entry) => entry.agent))]
    .filter((agent) => canOpen(activityTarget(agent, channelId)))
    .sort()
    .join(":");
  useEffect(() => {
    if (keys)
      void session.profiles
        .ensure(keys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, keys]);
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
  // Keep the announcement outside collapsed details; only the visually deduplicated
  // agent typing is represented here, while public human typing remains separate.
  const workingNames = keys
    .split(":")
    .filter(
      (agent) =>
        turns.some(
          (turn) => turn.agent === agent && turn.state === "working",
        ) || typing.some((entry) => entry.agent === agent),
    )
    .map((agent) =>
      resolveName(
        agent,
        identities.get(agent)?.name ?? `Agent ${agent.slice(0, 8)}`,
      ),
    );
  const agents = (
    <div className={styles.agents}>
      {keys.split(":").map((agent) => {
        const target = activityTarget(agent, channelId);
        const name = resolveName(
          agent,
          identities.get(agent)?.name ?? `Agent ${agent.slice(0, 8)}`,
        );
        const active = turns.filter((turn) => turn.agent === agent);
        const working = active.filter(
          (turn) => turn.state === "working",
        ).length;
        const unknown = active.length - working;
        const isWorking =
          working > 0 || typing.some((entry) => entry.agent === agent);
        const picture = identities.get(agent)?.picture;
        return (
          <ActivityEntry
            key={agent}
            tooltip={
              <>
                <p className="text-body-sm">
                  {threadRootId ? (
                    "Working in this thread. Details show channel activity, including other threads."
                  ) : (
                    <>
                      {working
                        ? `${working} working turn(s)`
                        : "No fresh working evidence"}
                      {unknown ? ` · ${unknown} with unknown status` : ""} in
                      this channel, including threads.
                      {isWorking && !working
                        ? " Fresh channel typing signal."
                        : ""}
                    </>
                  )}
                </p>
                <p className="text-body-sm">
                  Owner-only activity. Select to inspect.
                </p>
                <code className="font-mono text-mono">{agent}</code>
              </>
            }
            session={session}
            agent={agent}
            src={picture ? (session.media(picture) ?? null) : null}
            name={name}
            isWorking={isWorking}
            target={target}
            open={open}
          />
        );
      })}
    </div>
  );
  return (
    <section
      className={styles.root}
      data-buzz-ui=""
      aria-label={
        threadRootId
          ? "Agent activity in this thread"
          : "Agent activity in this channel"
      }
    >
      {workingNames.length > 0 && (
        <span className="sr-only" role="status">
          {workingNames.join(", ")}
          {workingNames.length === 1 ? " is working" : " are working"}
        </span>
      )}
      {threadRootId ? (
        agents
      ) : (
        // Observer turns have no thread identity. Keep all of them accessible
        // without presenting a second full list as conversation-local work.
        <details key={channelId}>
          <summary className={`text-body-sm ${styles.summary}`}>
            Channel-wide activity · {keys.split(":").length}{" "}
            {keys.includes(":") ? "agents" : "agent"}
          </summary>
          {agents}
        </details>
      )}
    </section>
  );
}

function ActivityEntry({
  session,
  agent,
  src,
  name,
  isWorking,
  target,
  open,
  tooltip,
}: {
  session: ComposerAccessoryProps["session"];
  agent: string;
  src: string | null;
  name: string;
  isWorking: boolean;
  target: ReturnType<typeof activityTarget>;
  open: ComposerAccessoryProps["open"];
  tooltip: ReactNode;
}) {
  const presence = usePresenceStatus(session.presence, agent);
  const Icon = isWorking ? DotsThreeIcon : QuestionIcon;
  return (
    <Tooltip content={tooltip}>
      <NavigationItem
        aria-label={`View activity for ${name} ${agent.slice(0, 12)}${presence === "unknown" ? "" : `, Presence: ${presence}`}`}
        onClick={() => open(target)}
        icon={
          <AgentAvatar
            working={isWorking}
            src={src}
            alt=""
            fallback={name}
            size="small"
            shape="squircle"
            statusBadge={presence === "unknown" ? undefined : presence}
          />
        }
        label={
          <>
            <span className={styles.name}>{name}</span>
            {" · "}
            <span className={styles.status}>
              {isWorking ? "working" : "status unknown"}
            </span>
          </>
        }
        trailing={
          <Icon
            className={styles.indicator}
            data-working={isWorking || undefined}
            size={18}
          />
        }
      />
    </Tooltip>
  );
}
