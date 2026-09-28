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
import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadAgentBlock } from "./thread-agent-groups";
import styles from "./ThreadAgentGroup.module.css";

// Mounted group presentation only: no telemetry, persistence or completion state.
export const CoordinationAuthors = createContext<ReadonlySet<string>>(
  new Set(),
);

export function ThreadAgentGroup({
  block,
  session,
  profiles,
  reveal,
  children,
  onCollapse,
}: {
  block: ThreadAgentBlock;
  session: RelaySession;
  profiles: ReadonlyMap<string, Profile>;
  reveal?: AbortSignal | undefined;
  children: ReactNode;
  onCollapse?(): void;
}) {
  const authors = useMemo(
    () => new Set(block.rows.map((row) => row.authorId)),
    [block.rows],
  );
  const [expanded, expand] = useState(false);
  const revealed = useRef<AbortSignal | undefined>(undefined);
  const name = useIdentityNames(session.names);
  useLayoutEffect(() => {
    if (reveal && !reveal.aborted && revealed.current !== reveal) {
      revealed.current = reveal;
      expand(true);
    }
  }, [reveal]);
  const delivery = block.request?.message.delivery;
  const status =
    delivery === "failed"
      ? "Request not sent"
      : delivery === "sending"
        ? "Sending request…"
        : delivery === "unknown"
          ? "Delivery unconfirmed"
          : block.request
            ? `${block.request.agents.length} awaiting reply`
            : "";
  return (
    <section
      aria-label="Agent coordination and activity"
      className={styles.group}
    >
      <Accordion
        variant="activity"
        value={expanded ? ["replies"] : []}
        onValueChange={(value) => {
          const open = value.includes("replies");
          if (!open) onCollapse?.();
          expand(open);
        }}
        items={[
          {
            value: "replies",
            title: (
              <span className={styles.summary}>
                <span className={styles.avatars} aria-hidden="true">
                  {block.agents.slice(0, 3).map((key) => {
                    const profile = profiles.get(key);
                    return (
                      <span key={key} className={styles.avatar}>
                        <Avatar
                          alt=""
                          shape="squircle"
                          fallback={name(key, profile?.name ?? "Agent")}
                          src={
                            profile?.picture
                              ? session.media(profile.picture)
                              : undefined
                          }
                        />
                      </span>
                    );
                  })}
                  {block.agents.length > 3 && (
                    <span className={styles.overflow}>
                      +{block.agents.length - 3}
                    </span>
                  )}
                </span>
                <span className="text-body-sm">
                  {block.agents.length}{" "}
                  {block.agents.length === 1 ? "agent" : "agents"}
                  {block.rows.length
                    ? ` · ${block.rows.length} coordination ${block.rows.length === 1 ? "message" : "messages"}`
                    : " · Activity"}
                  {status ? ` · ${status}` : ""}
                </span>
              </span>
            ),
            // Unmount immediately on collapse: hidden rows cannot earn read dwell or
            // claim typing replacement during the shared accordion's exit animation.
            content: expanded ? (
              <CoordinationAuthors.Provider value={authors}>
                {children}
              </CoordinationAuthors.Provider>
            ) : null,
          },
        ]}
      />
    </section>
  );
}
