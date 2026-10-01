import { usePresenceStatus } from "../../features/presence/react";
import {
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { LoadedThreadMessages } from "../../features/messages/loaded-thread-messages";
import { activityRecords } from "../../features/agents/activity-records";
import { activityTarget } from "../../features/agents/activity-target";
import { profileActivityViewTarget } from "../../features/profiles/target";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
} from "../../shared/design-system/ui/Popover";
import { ActivityStream } from "./ActivityStream";
import { threadActivity } from "./thread-activity";
import { useTypingReplacement } from "../../features/conversation/typing-presentation";
import styles from "./ActivityAccessory.module.css";

/** One bottom group per conversation. Exact identities, never one row per message. */
export function ActivityAccessory(props: ComposerAccessoryProps) {
  const { session, channelId, threadRootId, canOpen } = props;
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
  );
  const messages = useContext(LoadedThreadMessages);
  const entries = useMemo(() => {
    if (threadRootId)
      return threadActivity(snapshot, channelId, threadRootId, messages).filter(
        (entry) =>
          entry.working || entry.turns.some((turn) => turn.state === "unknown"),
      );
    const agents = new Set([
      ...snapshot.turns
        .filter(
          (turn) => turn.channelId === channelId && turn.state !== "ended",
        )
        .map((turn) => turn.agent),
      ...snapshot.typing
        .filter((entry) => entry.channelId === channelId && !entry.threadRootId)
        .map((entry) => entry.agent),
    ]);
    return [...agents].sort().map((agent) => ({
      agent,
      working:
        snapshot.status === "listening" &&
        (snapshot.turns.some(
          (turn) =>
            turn.agent === agent &&
            turn.channelId === channelId &&
            turn.state === "working",
        ) ||
          snapshot.typing.some(
            (entry) =>
              entry.agent === agent &&
              entry.channelId === channelId &&
              !entry.threadRootId,
          )),
      selected: {
        records: activityRecords(snapshot.records, agent, channelId),
      },
    }));
  }, [snapshot, channelId, threadRootId, messages]);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const keys = entries.map((entry) => entry.agent);
  const identityKeys = keys.join(":");
  useEffect(() => {
    if (identityKeys)
      void session.profiles
        .ensure(identityKeys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, identityKeys]);
  const suffixes = publicKeyLabels(keys);
  const names = keys.map((key) =>
    resolveName(key, profiles.get(key)?.name ?? suffixes.get(key) ?? "Agent"),
  );
  const visible = entries.filter((entry) =>
    canOpen(activityTarget(entry.agent, channelId)),
  );
  if (!visible.length) return null;
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
      <div className={styles.agents}>
        {visible.map((entry) => {
          const name = names[keys.indexOf(entry.agent)] ?? "Agent";
          const label =
            names.filter((value) => value === name).length > 1
              ? `${name} · ${suffixes.get(entry.agent)}`
              : name;
          return (
            <ActivityEntry
              key={entry.agent}
              {...props}
              agent={entry.agent}
              name={label}
              picture={profiles.get(entry.agent)?.picture}
              working={entry.working}
              records={entry.selected.records}
            />
          );
        })}
      </div>
    </section>
  );
}
function ActivityEntry({
  session,
  channelId,
  threadRootId,
  canOpen,
  open,
  agent,
  name,
  picture,
  working,
  records,
}: ComposerAccessoryProps & {
  agent: string;
  name: string;
  picture: string | undefined;
  working: boolean;
  records: ReturnType<typeof activityRecords>;
}) {
  const presence = usePresenceStatus(session.presence, agent);
  const [expanded, setExpanded] = useState(false);
  const target = profileActivityViewTarget(agent);
  useTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent },
    working,
  );
  return (
    <PopoverRoot open={expanded} onOpenChange={setExpanded}>
      <PopoverTrigger
        openOnHover
        render={
          <NavigationItem
            icon={
              <AgentAvatar
                working={working}
                src={picture ? (session.media(picture) ?? null) : null}
                alt=""
                fallback={name}
                size="small"
                shape="squircle"
                statusBadge={presence === "unknown" ? undefined : presence}
              />
            }
            aria-label={`View activity for ${name} ${agent.slice(0, 12)}${presence === "unknown" ? "" : `, Presence: ${presence}`}`}
            label={`${name} · ${working ? "working…" : "work status unknown"}`}
          />
        }
      />
      <PopoverPopup side="top" aria-label={`Activity for ${name}`}>
        <PopoverTitle>{name}</PopoverTitle>
        <PopoverDescription>
          {working ? "Working" : "Activity interrupted or out of date"}
          {threadRootId
            ? " in this thread"
            : " in this channel, including threads"}
        </PopoverDescription>
        {expanded && <ActivityStream records={records} />}
        {target && canOpen(target) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (open(target)) setExpanded(false);
            }}
          >
            View activity
          </Button>
        )}
        <PopoverClose
          render={
            <Button size="sm" variant="ghost">
              Close
            </Button>
          }
        />
      </PopoverPopup>
    </PopoverRoot>
  );
}
