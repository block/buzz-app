import type { HuddleAction, HuddleView } from "../../features/huddle/window";
import { HuddleAvatarCloud } from "./HuddleAvatarCloud";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  HeadphonesIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
} from "../../shared/design-system/icons";
import styles from "./Huddles.module.css";

export function HuddleWindowView({
  view,
  act,
  error,
}: {
  view: HuddleView;
  act(action: HuddleAction): void;
  error?: string | undefined;
}) {
  return (
    <main data-buzz-ui="" className={styles.window}>
      <header className={styles.windowHeader}>
        <span className="text-caption text-secondary">
          <HeadphonesIcon size={16} /> Huddle
        </span>
        {view.phase !== "connected" && (
          <p className="text-body text-secondary">
            {view.phase === "connecting"
              ? "Connecting your microphone…"
              : "Leaving…"}
          </p>
        )}
      </header>
      <HuddleAvatarCloud participants={view.participants} muted={view.muted} />
      <footer className={styles.windowFooter}>
        {error && (
          <p role="alert" className="text-caption text-secondary">
            {error}
          </p>
        )}
        <div className={styles.windowControls}>
          <IconButton
            size="large"
            variant={view.muted ? "subtle" : "solid"}
            aria-label={view.muted ? "Unmute" : "Mute"}
            title={view.muted ? "Unmute" : "Mute"}
            aria-pressed={view.muted}
            disabled={view.phase !== "connected"}
            onClick={() => act("mute")}
            icon={
              view.muted ? (
                <MicrophoneSlashIcon size={22} />
              ) : (
                <MicrophoneIcon size={22} />
              )
            }
          />
          <IconButton
            size="large"
            variant="destructive"
            aria-label="Leave huddle"
            title="Leave huddle"
            disabled={view.phase === "leaving"}
            onClick={() => act("leave")}
            icon={<PhoneDisconnectIcon size={22} />}
          />
        </div>
      </footer>
    </main>
  );
}
