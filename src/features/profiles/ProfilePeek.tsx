import { Button } from "../../shared/design-system/ui/Button";
import { ChatCircleIcon, RobotIcon } from "../../shared/design-system/icons";
import { useProfileMessage } from "./useProfileMessage";
import {
  useState,
  useSyncExternalStore,
  useEffect,
  useRef,
  useId,
  cloneElement,
  type ReactElement,
  type FocusEvent,
} from "react";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import { AgentAvatar } from "../agents/AgentAvatar";
import { usePresenceStatus } from "../presence/react";
import { useMessageDensity } from "../../shared/theme/message-density";
import type { RelaySession } from "../relay/session";
import { ProfileStatusBubble } from "./ProfileStatusBubble";
import { ProfileBackdrop } from "./ProfileBackdrop";
import { ProfileHeaderTime } from "./ProfileHeaderTime";
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

/** The full name, read only while the preview is open. */
function ActualName({
  session,
  pubkey,
  fallback,
}: {
  session: RelaySession;
  pubkey: string;
  fallback: string;
}) {
  const profile = useSyncExternalStore(session.profiles.subscribe, () =>
    session.profiles.snapshot().get(pubkey),
  );
  return (
    profile?.verified?.fullName ?? profile?.verified?.displayName ?? fallback
  );
}

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
  const compact = useMessageDensity() === "compact";
  const profileButton = useRef<HTMLButtonElement>(null);
  const returningFromProfile = useRef<"pending" | "returned" | null>(null);
  const [watchReturnPointer, setWatchReturnPointer] = useState(false);
  const pointerLeft = useRef(false);
  const triggerId = useId();
  const previewId = useId();
  useEffect(() => {
    if (!watchReturnPointer) return;
    // The profile can obscure its trigger, so a real pointer exit may not
    // reach the avatar's leave handler. Observe only during this handoff.
    const track = (event: globalThis.PointerEvent) => {
      const rect = document.getElementById(triggerId)?.getBoundingClientRect();
      // Once the pointer has left, a later return is a fresh visit, even when
      // the hover opens only after the pointer rests back on the avatar.
      if (rect && !pointerLeft.current)
        pointerLeft.current =
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom;
    };
    document.addEventListener("pointermove", track, {
      capture: true,
      passive: true,
    });
    return () => document.removeEventListener("pointermove", track, true);
  }, [watchReturnPointer, triggerId]);
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
      if (returningFromProfile.current === "returned") {
        returningFromProfile.current = null;
        setWatchReturnPointer(false);
      }
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
    onOpened(link) {
      if (!onOpen(link))
        throw new Error("Could not open the conversation. Try again.");
      setOpen(false);
    },
  });
  const openProfile = () => {
    const avatar = document.getElementById(triggerId);
    avatar?.focus();
    setOpen(false);
    returningFromProfile.current = "pending";
    pointerLeft.current = !avatar?.matches(":hover");
    setWatchReturnPointer(true);
    if (!onOpen(target)) {
      returningFromProfile.current = null;
      setWatchReturnPointer(false);
    }
  };
  return (
    <PreviewCard
      trigger={cloneElement(
        trigger as ReactElement<
          {
            id?: string;
            onClick?: () => void;
          } & typeof focusRegion
        >,
        {
          id: triggerId,
          onClick: openProfile,
          ...focusRegion,
          onFocus: () => {
            if (returningFromProfile.current === "pending")
              returningFromProfile.current = "returned";
            focusRegion.onFocus();
          },
        },
      )}
      id={previewId}
      open={open}
      onOpenChange={(next, details) => {
        // Crossing an avatar on the active toolbar's safe pointer route must
        // not put a new preview between the message and its actions. A compact
        // row reveals its actions anywhere in the row, avatar included, so
        // there they do not mark a route.
        const avatar = document.getElementById(triggerId);
        if (
          next &&
          !compact &&
          details.reason === "trigger-hover" &&
          document.activeElement !== avatar &&
          avatar?.closest("[data-actions-revealed]")
        ) {
          details.cancel();
          return;
        }
        // Return focus is not a fresh request to preview the same identity.
        if (next && returningFromProfile.current) {
          if (
            returningFromProfile.current === "returned" &&
            details.reason === "trigger-hover" &&
            pointerLeft.current
          ) {
            returningFromProfile.current = null;
            setWatchReturnPointer(false);
          } else {
            details.cancel();
            return;
          }
        }
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
    >
      <div className={styles.content} {...focusRegion}>
        <div className={styles.lockup} data-no-picture={!picture || undefined}>
          <button
            ref={profileButton}
            type="button"
            className={styles.openProfile}
            aria-label="View profile"
            onClick={openProfile}
          >
            <div className={styles.backdrop}>
              <ProfileBackdrop src={picture} />
            </div>
            <div className={styles.artwork}>
              {session && (
                <ProfileStatusBubble
                  session={session}
                  pubkey={pubkey}
                  compact
                />
              )}
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
                  statusBadgeSize="compact"
                  statusBadge={presence === "unknown" ? undefined : presence}
                />
              </div>
            </div>
            <div className={styles.identity}>
              <div className={`${styles.name} text-label-sm`}>
                {agent && <RobotIcon aria-label="Agent" size={14} />}
                {session ? (
                  <ActualName
                    session={session}
                    pubkey={pubkey}
                    fallback={name}
                  />
                ) : (
                  name
                )}
              </div>
              {session && (
                <ProfileHeaderTime session={session} pubkey={pubkey} />
              )}
            </div>
          </button>
        </div>
        {message.available && (
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="subtle"
              aria-label="Message"
              loading={message.opening}
              onClick={() => void message.open()}
            >
              <ChatCircleIcon size={16} />
              Message
            </Button>
          </div>
        )}
        {message.error && (
          <p role="alert" className="text-body-sm text-danger">
            {message.error}
          </p>
        )}
      </div>
    </PreviewCard>
  );
}
