import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { RobotIcon } from "../../shared/design-system/icons";
import { useMessageDensity } from "../../shared/theme/message-density";
import { ProfilePeek } from "../profiles/ProfilePeek";
import { profileTarget } from "../profiles/target";
import type { RelaySession } from "../relay/session";
import { AuthorLink } from "./AuthorLink";
import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import styles from "./Messages.module.css";

/** Incoming message geometry for work that has not published a response yet. */
export function AgentResponsePreview({
  name,
  picture,
  participants = [],
  layout = "timeline",
  children,
  stackPrevious = false,
  bylineHint,
  profile,
}: {
  bylineHint?: ReactNode;
  stackPrevious?: boolean;
  name: string;
  picture?: string | undefined;
  participants?: readonly {
    id: string;
    name: string;
    picture?: string | undefined;
  }[];
  layout?: "timeline" | "thread" | "continuation" | undefined;
  children: ReactNode;
  /** The named agent and how to open profiles: a lone avatar opens its
   * agent's, and the name the named agent's, as a message author's do. */
  profile?:
    | Readonly<{
        pubkey: string;
        session: RelaySession | undefined;
        channelId: string;
        canOpen(target: string): boolean;
        open(target: string): boolean;
      }>
    | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  // A retiring row hands a focused avatar, name or control to its neighbour.
  useActivityFocusHandoff(root);
  // Like a message author's avatar, a focused avatar or name outlives a live
  // change (a group forming, a stacked row) until focus moves on.
  const [focusedAvatar, setFocusedAvatar] = useState<string>();
  const [focusedName, setFocusedName] = useState(false);
  // A flat list's group avatar is on its first row; a continuation keeps only
  // the label, which names the row while its byline is omitted, and no hidden
  // profile control.
  const flat = useMessageDensity() === "compact";
  const hiddenAvatar = stackPrevious && flat && !focusedAvatar;
  // A focused avatar keeps its place while agents ahead of it join.
  const held = participants.findIndex((agent) => agent.id === focusedAvatar);
  const avatars: typeof participants = participants.length
    ? participants.filter(
        (_, index) => index < (held > 2 ? 2 : 3) || index === held,
      )
    : [{ id: "primary", name, picture }];
  const departed =
    !!focusedAvatar && !avatars.some((agent) => agent.id === focusedAvatar);
  // When its agent stops, the row's first control (the remaining agent's
  // avatar, or the bubble's) takes focus.
  useLayoutEffect(() => {
    if (!departed) return;
    setFocusedAvatar(undefined);
    const row = root.current;
    if (row && row.ownerDocument.activeElement === row.ownerDocument.body)
      row
        .querySelector<HTMLElement>("button:not([disabled])")
        ?.focus({ preventScroll: true });
  }, [departed]);
  const lone = avatars.length === 1;
  const opener = (pubkey: string) => {
    const target = profileTarget(pubkey, { agent: true });
    return profile && target && profile.canOpen(target)
      ? { ...profile, pubkey, target }
      : undefined;
  };
  const namedAgent = profile && opener(profile.pubkey);
  // A lone avatar opens its agent's profile; a group is one labelled image.
  const peeks = avatars.map((agent) =>
    (lone && !hiddenAvatar) || agent.id === focusedAvatar
      ? participants.length
        ? opener(agent.id)
        : namedAgent
      : undefined,
  );
  const nameHeld = focusedName && !!namedAgent;
  // Only a lone agent's name opens a profile: a group's name is one of many.
  const link = lone || nameHeld ? namedAgent : undefined;
  const byline = (
    <>
      <RobotIcon aria-hidden="true" className={styles.authorAgentIcon} />
      {name}
    </>
  );
  return (
    <div
      ref={root}
      className={styles.message}
      data-stack-previous={stackPrevious || undefined}
      data-layout={layout}
      data-agent-response-preview=""
    >
      <span className={styles.messageGutter} />
      <div className={styles.messageBody}>
        <div className={styles.messageContent}>
          <div className={hiddenAvatar ? "sr-only" : styles.messageAvatar}>
            <span
              className={styles.agentAvatarGroup}
              data-count={Math.max(1, Math.min(participants.length, 3))}
              {...(peeks.some(Boolean)
                ? {}
                : {
                    role: "img",
                    "aria-label": participants.length
                      ? participants.map((agent) => agent.name).join(", ")
                      : name,
                  })}
            >
              {avatars.map((agent, index) => {
                const peek = peeks[index];
                const avatar = (
                  <Avatar
                    src={agent.picture}
                    alt=""
                    fallback={agent.name}
                    shape="squircle"
                    size="fill"
                  />
                );
                return (
                  <span
                    key={agent.id}
                    className={styles.agentAvatarGroupItem}
                    title={peek ? undefined : agent.name}
                  >
                    {peek ? (
                      <ProfilePeek
                        viewer={peek.session?.viewer}
                        name={agent.name}
                        picture={agent.picture}
                        pubkey={peek.pubkey}
                        agent
                        session={peek.session}
                        channelId={peek.channelId}
                        target={peek.target}
                        onOpen={peek.open}
                        onFocusChange={(focused) =>
                          setFocusedAvatar(focused ? agent.id : undefined)
                        }
                        trigger={
                          <IconButton
                            size={layout === "timeline" ? "md" : "sm"}
                            shape="round"
                            aria-label={`View ${agent.name} profile`}
                            icon={avatar}
                          />
                        }
                      />
                    ) : (
                      avatar
                    )}
                  </span>
                );
              })}
            </span>
          </div>
          {(!stackPrevious || nameHeld) && (
            <div className={styles.messageHeader}>
              <div className={styles.byline}>
                <strong className={styles.author}>
                  {link ? (
                    <AuthorLink
                      pubkey={link.pubkey}
                      onOpen={() => link.open(link.target)}
                      onFocusChange={setFocusedName}
                    >
                      {byline}
                    </AuthorLink>
                  ) : (
                    byline
                  )}
                </strong>
                {bylineHint}
              </div>
            </div>
          )}
          <div className={styles.messageBubble}>{children}</div>
        </div>
      </div>
    </div>
  );
}
