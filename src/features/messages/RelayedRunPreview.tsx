import { useRef, type ReactNode } from "react";
import { useChannelIdentityNames } from "../identity-names/react";
import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { formatTime } from "../../shared/datetime";
import { ActivityDisclosure } from "./ActivityDisclosure";
import type { RelayedRun } from "./activity-groups";
import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import styles from "./Messages.module.css";

/** One line for a run of messages relayed from other chats: who wrote them,
 * how many and when. Opening it shows each relayed line. */
export function RelayedRunPreview({
  run,
  session,
  profiles,
  agentPubkeys,
  media,
  expanded,
  onToggle,
  renderHistory,
}: {
  run: RelayedRun;
  session?: RelaySession | undefined;
  profiles: ReadonlyMap<string, Profile>;
  agentPubkeys?: ReadonlySet<string> | undefined;
  media: (url: string, size?: "small") => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  renderHistory: (row: RelayedRun["relayed"][number]) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const first = run.relayed[0];
  const last = run.relayed.at(-1);
  const resolveName = useChannelIdentityNames(session, first?.channelId);
  useActivityFocusHandoff(container);
  if (!first || !last) return null;
  const agents = [
    ...new Set(run.relayed.flatMap((row) => row.relayedFrom?.agent ?? [])),
  ];
  const named = agents.map((id) => ({
    id,
    name: resolveName(id, profiles.get(id)?.name ?? id.slice(0, 10)),
    src: avatarMedia(profiles.get(id)?.picture, media),
    shape:
      agentPubkeys?.has(id) || profiles.get(id)?.isAgent
        ? ("squircle" as const)
        : ("circle" as const),
  }));
  const start = formatTime(first.createdAt);
  const end = formatTime(last.createdAt);
  const summary = `${run.relayed.length} messages from other chats`;
  const names = named.map((agent) => agent.name).join(", ");
  const time = start === end ? start : `${start}–${end}`;
  return (
    <ActivityDisclosure
      container={container}
      expanded={expanded}
      onToggle={onToggle}
      label={`${expanded ? "Collapse" : "Show"} ${summary}: ${names}, ${time}`}
      icon={<AvatarStack size="mini" items={named} />}
      summary={
        <>
          {summary} <span className={styles.relayedSource}>{names}</span>
          <span className={styles.relayedTime}> {time}</span>
        </>
      }
    >
      {run.relayed.map((row) => (
        <div key={row.id}>{renderHistory(row)}</div>
      ))}
    </ActivityDisclosure>
  );
}
