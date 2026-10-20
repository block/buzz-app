import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  UserIcon,
  ChatCircleIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { useProfileMessage } from "./useProfileMessage";
import {
  useState,
  useRef,
  useId,
  cloneElement,
  type ReactElement,
  type FocusEvent,
} from "react";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import { AgentAvatar } from "../agents/AgentAvatar";
import { usePresenceStatus } from "../presence/react";
import type { RelaySession } from "../relay/session";
import { UserStatusDisplay } from "../user-status/StatusDisplay";
import { ProfileBackdrop } from "./ProfileBackdrop";
import styles from "./ProfilePeek.module.css";

type ProfilePeekProps = {
  trigger: ReactElement;
  name: string;
  picture: string | undefined;
  pubkey: string;
  agent: boolean;
  session: RelaySession | undefined;
  channelId: string;
  viewer: string | undefined;
  target: string;
  onOpen(target: string): boolean;
  onFocusChange?(focused: boolean): void;
};

/** A lightweight look at the same identity the avatar opens in the profile panel. */
export function ProfilePeek({
  trigger,
  target,
  onOpen,
  name,
  picture,
  pubkey,
  agent,
  session,
  channelId,
  viewer,
  onFocusChange,
}: ProfilePeekProps) {
  const [open, setOpen] = useState(false);
  const profileButton = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const previewId = useId();
  const focusRegion = {
    onFocus: () => onFocusChange?.(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      // Window blur retains the browser's return-focus target.
      if (!next && document.activeElement === event.target) return;
      if (
        next instanceof Node &&
        (document.getElementById(triggerId)?.contains(next) ||
          document.getElementById(previewId)?.contains(next))
      )
        return;
      onFocusChange?.(false);
    },
  };
  const presence = usePresenceStatus(
    open ? session?.presence : undefined,
    pubkey,
    true,
  );
  const message = useProfileMessage({
    session,
    pubkey,
    viewer,
    agent,
    enabled: open,
    onOpened(channelId) {
      if (!onOpen(`buzz://channel/${encodeURIComponent(channelId)}`))
        throw new Error("Could not open the conversation. Try again.");
      setOpen(false);
    },
  });
  return (
    <PreviewCard
      trigger={cloneElement(
        trigger as ReactElement<{ id?: string } & typeof focusRegion>,
        {
          id: triggerId,
          ...focusRegion,
        },
      )}
      id={previewId}
      open={open}
      onOpenChange={(next, details) => {
        if (!next && message.opening && details.reason === "trigger-hover") {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
      side="right"
      className={styles.card ?? ""}
      aria-label={`${name} profile preview`}
      actionRef={profileButton}
      delay={250}
    >
      <div className={styles.content} {...focusRegion}>
        <div className={styles.lockup} data-no-picture={!picture || undefined}>
          <div className={styles.backdrop}>
            <ProfileBackdrop src={picture} kind={agent ? "agent" : "human"} />
          </div>
          <div className={styles.artwork}>
            <div className={styles.portrait}>
              <AgentAvatar
                session={session}
                agentPubkey={pubkey}
                channelId={channelId}
                src={picture}
                alt=""
                fallback={name}
                size="fill"
                shape={agent ? "squircle" : "circle"}
                statusBadge={presence === "unknown" ? undefined : presence}
              />
            </div>
          </div>
          <div className={styles.identity}>
            <div className={`${styles.name} text-label-sm`}>
              {agent && <RobotIcon aria-label="Agent" size={14} />}
              {name}
            </div>
            {session && (
              <UserStatusDisplay
                session={session}
                userId={pubkey}
                size="caption"
              />
            )}
          </div>
        </div>
        <div className={styles.actions}>
          <IconButton
            ref={profileButton}
            size="sm"
            shape="round"
            variant="subtle"
            aria-label="View profile"
            onClick={() => {
              document.getElementById(triggerId)?.focus();
              setOpen(false);
              onOpen(target);
            }}
            icon={
              <span className={styles.actionContent}>
                {agent ? <RobotIcon size={16} /> : <UserIcon size={16} />}
                <span className={styles.actionText} aria-hidden="true">
                  Profile
                </span>
              </span>
            }
          />
          {message.available && (
            <IconButton
              size="sm"
              shape="round"
              variant="subtle"
              aria-label="Message"
              loading={message.opening}
              onClick={() => void message.open()}
              icon={
                <span className={styles.actionContent}>
                  <ChatCircleIcon size={16} />
                  <span className={styles.actionText} aria-hidden="true">
                    Message
                  </span>
                </span>
              }
            />
          )}
        </div>
        {message.error && (
          <p role="alert" className="text-body-sm text-danger">
            {message.error}
          </p>
        )}
      </div>
    </PreviewCard>
  );
}
