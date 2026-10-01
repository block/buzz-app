import type { HuddleAction, HuddleView } from "../../features/huddle/window";
import { HuddleAvatarCloud } from "./HuddleAvatarCloud";
import { HuddleDiscussionView } from "./HuddleDiscussionView";
import { Panel } from "../../shared/design-system/ui/Panel";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  HeadphonesIcon,
  ChatCircleIcon,
  ArrowsInIcon,
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
  act(action: HuddleAction, text?: string): void;
  error?: string | undefined;
}) {
  return (
    <div
      className={styles.windowLayout}
      data-chat={!!view.discussion || undefined}
    >
      <main data-buzz-ui="" className={styles.window}>
        <header className={styles.windowHeader}>
          <div className={styles.windowMinimize}>
            <IconButton
              size="toolbar"
              variant="ghost"
              aria-label="Minimize Huddle to compact controls"
              title="Minimize Huddle"
              onClick={() => act("minimize")}
              icon={<ArrowsInIcon size={16} />}
            />
          </div>
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
        <HuddleAvatarCloud
          participants={view.participants}
          muted={view.muted}
        />
        <footer className={styles.windowFooter}>
          {error && (
            <p role="alert" className="text-caption text-secondary">
              {error}
            </p>
          )}
          <div className={styles.windowControls}>
            <IconButton
              size="large"
              variant="subtle"
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
              variant="subtle"
              aria-label="Huddle chat"
              title="Huddle chat"
              aria-expanded={!!view.discussion}
              onClick={() => act("thread")}
              icon={<ChatCircleIcon size={22} />}
            />
            <IconButton
              size="large"
              variant="subtle"
              data-huddle-leave=""
              aria-label="Leave huddle"
              title="Leave huddle"
              disabled={view.phase === "leaving"}
              onClick={() => act("leave")}
              icon={<PhoneDisconnectIcon size={22} />}
            />
          </div>
        </footer>
      </main>
      {view.discussion && (
        <aside
          className={styles.windowDiscussion}
          aria-label="Huddle chat panel"
        >
          <Panel>
            <HuddleDiscussionView
              discussion={view.discussion}
              close={() => act("thread")}
              send={(text) => act("send", text)}
              older={() => act("older")}
              retry={() => act("retry")}
              recover={(id, dismiss) =>
                act(dismiss ? "discardMessage" : "retryMessage", id)
              }
            />
          </Panel>
        </aside>
      )}
    </div>
  );
}
