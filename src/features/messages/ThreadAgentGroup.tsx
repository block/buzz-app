import {
  createContext,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useIdentityNames } from "../identity-names/react";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadAgentBlock } from "./thread-agent-groups";
import styles from "./ThreadAgentGroup.module.css";

// Presentation only. Coordination never settles pending work or owns capture.
export const CoordinationAuthors = createContext<ReadonlySet<string>>(
  new Set(),
);

/** Brad's per-message disclosure: no aggregate wrapper or second reveal step. */
export function ThreadAgentGroup({
  block,
  session,
  profiles,
  reveal,
  revealMessageId,
  children,
  coordination,
  onHideCoordination,
}: {
  block: ThreadAgentBlock;
  session: RelaySession;
  profiles: ReadonlyMap<string, Profile>;
  reveal?: AbortSignal | undefined;
  revealMessageId?: string | undefined;
  children: ReactNode;
  coordination?: ((row: ChannelMessage) => ReactNode) | undefined;
  onHideCoordination?(): void;
}) {
  const authors = useMemo(
    () => new Set(block.rows.map((row) => row.authorId)),
    [block.rows],
  );
  return (
    <section
      aria-label="Agent coordination and activity"
      className={styles.group}
    >
      <CoordinationAuthors.Provider value={authors}>
        {block.rows.map((row) => (
          <CoordinationRow
            key={row.id}
            row={row}
            session={session}
            profile={profiles.get(row.authorId)}
            reveal={revealMessageId === row.id ? reveal : undefined}
            onHide={revealMessageId === row.id ? onHideCoordination : undefined}
          >
            {coordination?.(row)}
          </CoordinationRow>
        ))}
        {children}
      </CoordinationAuthors.Provider>
    </section>
  );
}
function CoordinationRow({
  row,
  session,
  profile,
  reveal,
  children,
  onHide,
}: {
  row: ChannelMessage;
  session: RelaySession;
  profile: Profile | undefined;
  reveal: AbortSignal | undefined;
  children: ReactNode;
  onHide: (() => void) | undefined;
}) {
  const [expanded, expand] = useState(false);
  const revealed = useRef<AbortSignal | undefined>(undefined);
  const resolveName = useIdentityNames(session.names);
  const name = resolveName(row.authorId, profile?.name ?? "Agent");
  useLayoutEffect(() => {
    if (reveal && !reveal.aborted && revealed.current !== reveal) {
      revealed.current = reveal;
      expand(true);
    }
  }, [reveal]);
  return (
    <Accordion
      variant="activity"
      value={expanded ? [row.id] : []}
      onValueChange={(values) => {
        const next = values.includes(row.id);
        expand(next);
        if (!next) onHide?.();
      }}
      items={[
        {
          value: row.id,
          title: (
            <span className={styles.summary}>
              <Avatar
                alt=""
                fallback={name}
                shape="squircle"
                size="small"
                src={
                  profile?.picture
                    ? session.media(profile.picture, "small")
                    : undefined
                }
              />
              <span className="text-label-sm">{name}</span>{" "}
              <span className="text-caption text-subtle"> · Coordination</span>
              {!expanded && (
                <span
                  aria-hidden="true"
                  className={`${styles.preview} text-body-sm text-subtle`}
                >
                  {row.content?.replace(/\s+/g, " ").trim().slice(0, 160)}
                </span>
              )}
            </span>
          ),
          // Unmount immediately: hidden coordination cannot earn read dwell, even on exit.
          content: expanded ? <ol>{children}</ol> : null,
        },
      ]}
    />
  );
}
