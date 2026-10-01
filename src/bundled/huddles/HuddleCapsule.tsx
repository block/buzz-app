import { useState, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import { HuddleAvatarStack } from "./HuddleAvatarStack";
import type { HuddleWindow } from "../../features/huddle/window";
import type { Huddles } from "../../features/huddle/service";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  XIcon,
} from "../../shared/design-system/icons";
import styles from "./Huddles.module.css";

export function HuddleWaveform({
  level = 0,
  muted = false,
}: {
  level?: number;
  muted?: boolean;
}) {
  return (
    <span className={styles.waveform} data-muted={muted} aria-hidden="true">
      {[0.4, 0.75, 1, 0.6, 0.35].map((weight, i) => (
        <span
          key={weight}
          style={{
            height: `${3 + (muted ? 0 : level * weight * 17 + (i % 2) * 2)}px`,
          }}
        />
      ))}
    </span>
  );
}
export function HuddleCapsule({
  huddles,
  relay,
  companion,
}: {
  huddles: Huddles;
  relay: RelayData;
  companion: HuddleWindow;
}) {
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  const presentation = useSyncExternalStore(
    companion.subscribe,
    companion.snapshot,
  );
  const [error, setError] = useState<string>();
  const audioUnavailable = call.error
    ?.toLowerCase()
    .includes("huddle audio unavailable in this deployment");
  if (call.phase === "error")
    return (
      <div className={styles.capsuleWrap}>
        <fieldset
          className={`${styles.capsule} glass-primary`}
          aria-label="Huddle error"
        >
          <span className="text-caption text-primary">
            {audioUnavailable ? "Huddle audio unavailable" : "Couldn’t connect"}
          </span>
          <IconButton
            size="toolbar"
            variant="ghost"
            aria-label="Dismiss Huddle error"
            title="Dismiss"
            icon={<XIcon size={16} />}
            onClick={() => void huddles.leave()}
          />
        </fieldset>
        <span role="alert" className={styles.capsuleError}>
          {audioUnavailable
            ? "Huddle audio isn’t available on this server. A relay administrator needs to check its configuration."
            : `${call.error} Try the headphone button again.`}
        </span>
      </div>
    );
  if (presentation.visible || call.phase !== "connected") return null;
  return (
    <div className={styles.capsuleWrap}>
      <fieldset
        id="huddle-capsule"
        tabIndex={-1}
        className={`${styles.capsule} glass-primary`}
        aria-label="Active Huddle"
      >
        <Button
          variant="ghost"
          size="xs"
          style={{ padding: "var(--space-1)", paddingLeft: "var(--space-2)" }}
          aria-label={`Open Huddle window for ${call.destination?.channelName ?? "conversation"}`}
          title="Open Huddle window"
          onClick={() => {
            setError(undefined);
            void companion.open().catch((e) => setError(String(e)));
          }}
        >
          <span className={styles.capsuleContent}>
            <HuddleWaveform level={call.level ?? 0} muted={call.muted} />
            <HuddleAvatarStack participants={call.participants} relay={relay} />
          </span>
        </Button>
        <IconButton
          size="toolbar"
          variant="ghost"
          aria-label={call.muted ? "Unmute" : "Mute"}
          title={call.muted ? "Unmute" : "Mute"}
          aria-pressed={call.muted}
          onClick={() => huddles.mute()}
          icon={
            call.muted ? (
              <MicrophoneSlashIcon size={16} />
            ) : (
              <MicrophoneIcon size={16} />
            )
          }
        />
        <span className={styles.capsuleDivider} aria-hidden="true" />
        <Button
          size="xs"
          variant="ghost"
          style={{ alignSelf: "stretch" }}
          aria-label="Leave huddle"
          title="Leave huddle"
          onClick={() => void huddles.leave()}
        >
          Leave
        </Button>
      </fieldset>
      {(error || presentation.failed) && (
        <span role="alert" className={styles.capsuleError}>
          Couldn’t open Huddle window. Try again.
        </span>
      )}
    </div>
  );
}
