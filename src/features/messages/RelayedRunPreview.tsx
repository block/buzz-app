import { useRef, type ReactNode } from "react";
import { useChannelIdentityNames } from "../identity-names/react";
import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { formatTimeRange } from "../../shared/datetime";
import { CaretDownIcon, CaretUpIcon } from "../../shared/design-system/icons";
import type { RelayedRun } from "./activity-groups";
import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import styles from "./Messages.module.css";

/** One line for a run of messages relayed from other chats, in the shape of
 * each relayed line: who wrote them, how many and when. Opening it lists each
 * relayed line below it. */
export function RelayedRunPreview({
  run,
  session,
  profiles,
  agentPubkeys,
  media,
  expanded,
  onToggle,
  renderHistory,
  layout = "timeline",
}: {
  run: RelayedRun;
  session?: RelaySession | undefined;
  profiles: ReadonlyMap<string, Profile>;
  agentPubkeys?: ReadonlySet<string> | undefined;
  media: (url: string, size?: "small") => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  renderHistory: (row: RelayedRun["relayed"][number]) => ReactNode;
  layout?: "timeline" | "thread";
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
  const count = `${run.relayed.length} messages`;
  const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(
    named.map((agent) => agent.name),
  );
  const time = formatTimeRange(first.createdAt, last.createdAt);
  return (
    <div ref={container} className={styles.relayedRun} data-layout={layout}>
      <div className={styles.relayedHeader} data-open={expanded || undefined}>
        <button
          type="button"
          data-buzz-ui=""
          className={styles.relayedTrigger}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Show"} ${count} from other chats: ${names}, ${time}`}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onToggle();
          }}
        />
        <span className={styles.relayedAvatar} aria-hidden="true">
          <AvatarStack size="mini" items={named} />
        </span>
        <span className={styles.relayedName} aria-hidden="true">
          {count}
        </span>
        <span className={styles.relayedSubtle} aria-hidden="true">
          from other chats
        </span>
        <span className={styles.relayedPreview} aria-hidden="true">
          {names}
        </span>
        <span className={styles.relayedTime} aria-hidden="true">
          {time}
        </span>
        {expanded ? (
          <CaretUpIcon className={styles.relayedCaret} aria-hidden="true" />
        ) : (
          <CaretDownIcon className={styles.relayedCaret} aria-hidden="true" />
        )}
      </div>
      {expanded && (
        <div className={styles.relayedRunItems}>
          {run.relayed.map((row) => (
            <div key={row.id}>{renderHistory(row)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
