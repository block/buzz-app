import { useHuddleRequestFocus } from "./useHuddleRequestFocus";
import { HuddleAudioSettings } from "./HuddleAudioSettings";
import { LayoutGroup } from "motion/react";
import { useEffect, useId } from "react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { useState, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import type { Agents } from "../../features/agents/service";
import { useAgentsSnapshot } from "../../features/agents/react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { HuddleAvatarStack } from "./HuddleAvatarStack";
import { dmVoiceAgent } from "../../features/huddle/dm-agent";
import { huddleFailure } from "../../features/huddle/failure";
import { useIncomingHuddle } from "../../features/huddle/use-incoming";
import type { HuddleDestination } from "../../features/huddle/bridge";
import type { HuddleWindow } from "../../features/huddle/window";
import type { HuddleSnapshot, Huddles } from "../../features/huddle/service";
import { StartHuddleDialog } from "./StartHuddleDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
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
export function HuddleCapsule(props: {
  huddles: Huddles;
  relay: RelayData;
  companion: HuddleWindow;
  agents?: Agents | undefined;
}) {
  return (
    <LayoutGroup id={useId()}>
      <HuddleCapsuleContent {...props} />
    </LayoutGroup>
  );
}
/** The header launcher's confirmation, for a Join again with no room left to
 * join: it names the voice agent a new call in its DM invites. */
function StartAgain({
  relay,
  agents,
  destination,
  onClose,
  onStart,
}: {
  relay: RelayData;
  agents?: Agents | undefined;
  destination: HuddleDestination;
  onClose(): void;
  onStart(): void;
}) {
  const connection = useRelayConnection(relay);
  useAgentsSnapshot(agents);
  // Load archive evidence so an archived agent is never named or invited.
  useAgentChoices(connection.session, false, true);
  const voiceAgent = agents && dmVoiceAgent(connection, destination, agents);
  return (
    <StartHuddleDialog
      voiceAgent={voiceAgent?.name}
      onClose={onClose}
      onStart={onStart}
    />
  );
}
function HuddleCapsuleContent({
  huddles,
  relay,
  companion,
  agents,
}: {
  huddles: Huddles;
  relay: RelayData;
  companion: HuddleWindow;
  agents?: Agents | undefined;
}) {
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  const connection = useRelayConnection(relay);
  const { session } = connection;
  // Whether a failed call's room is still live in its conversation, so Join
  // again can return to it.
  const live = useIncomingHuddle(
    call.phase === "error" &&
      call.room &&
      call.destination &&
      call.destination.scope === connection.scope &&
      call.destination.viewer === connection.viewer
      ? session
      : undefined,
    call.destination?.channelId ?? "",
  );
  // Bound to the failed call it was asked for, so it never starts another.
  const [confirming, setConfirming] = useState<HuddleSnapshot>();
  if (confirming && confirming !== call) setConfirming(undefined);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const presentation = useSyncExternalStore(
    companion.subscribe,
    companion.snapshot,
  );
  const [error, setError] = useState<string>();
  const focus = useHuddleRequestFocus(call.phase === "connected", call.error);
  // The notice shows one mapped sentence; keep the native text for support.
  const failed = call.phase === "error" ? call : undefined;
  useEffect(() => {
    if (failed?.error) console.warn("Huddle failed:", failed.error);
  }, [failed]);
  if (call.phase === "error") {
    const failure = huddleFailure(call.error, !!call.dropped);
    const { destination } = call;
    // Join again returns to the failed call's room while it is live. With no
    // room to return to, a new call turns the microphone on and may invite a
    // voice agent, so it asks first, as the header launcher does.
    const room =
      destination &&
      call.room &&
      live?.id === call.room &&
      huddles.canJoin(destination.scope, call.room)
        ? call.room
        : undefined;
    return (
      <>
        <ToastNotice
          title={failure.title}
          description={failure.description}
          closeLabel="Dismiss Huddle error"
          onDismiss={() => void huddles.leave()}
        >
          {failure.rejoin && destination && (
            <Button
              size="compact"
              onClick={() =>
                room
                  ? void huddles.join(destination, room)
                  : setConfirming(call)
              }
            >
              Join again
            </Button>
          )}
        </ToastNotice>
        {confirming === call && destination && (
          <StartAgain
            relay={relay}
            agents={agents}
            destination={destination}
            onClose={() => setConfirming(undefined)}
            onStart={() => void huddles.start(destination)}
          />
        )}
      </>
    );
  }
  if (
    (call.phase === "incoming" ||
      (call.phase === "connecting" && call.requester)) &&
    call.destination &&
    call.room
  ) {
    const { destination, room } = call;
    const caller =
      profiles.get(call.requester ?? "")?.name ||
      formatPublicKey(call.requester ?? "") ||
      "Someone";
    return (
      <fieldset
        id="huddle-capsule"
        tabIndex={-1}
        className={`${styles.capsule} glass-primary`}
        ref={focus.requestRef}
        aria-label="Huddle request"
      >
        <Button
          size="sm"
          variant="ghost"
          aria-label="Open Huddle request"
          style={{ padding: "var(--space-1)" }}
          onClick={() => {
            void companion.open().catch(() => {});
          }}
        >
          <span className={styles.capsuleContent}>
            <HuddleAvatarStack
              thinking={call.thinking}
              speakers={call.speakers}
              participants={call.participants}
              relay={relay}
              transition
            />
            <span className={styles.callerName}>
              {Array.from(caller).slice(0, 80).join("")} calling
            </span>
          </span>
        </Button>
        {call.error && (
          <span role="alert" className="text-caption text-danger">
            {huddleFailure(call.error, false).description}
          </span>
        )}
        <span className={styles.requestCompactActions}>
          <Button
            size="sm"
            variant="subtle"
            data-huddle-join=""
            disabled={call.phase === "connecting"}
            onClick={() => {
              focus.cancel.current?.focus({ preventScroll: true });
              void huddles.join(destination, room);
            }}
          >
            Join
          </Button>
          <Button
            size="sm"
            variant="destructive"
            ref={focus.cancel}
            onClick={() => {
              void huddles.leave();
            }}
          >
            {call.phase === "connecting" ? "Cancel" : "Decline"}
          </Button>
        </span>
      </fieldset>
    );
  }
  if (call.phase === "connecting")
    return (
      <fieldset
        id="huddle-capsule"
        tabIndex={-1}
        className={`${styles.capsule} glass-primary`}
        ref={focus.requestRef}
        aria-label="Connecting to Huddle"
      >
        <span className={styles.callerName}>Connecting to Huddle…</span>
        <Button
          size="sm"
          variant="destructive"
          ref={focus.cancel}
          onClick={() => void huddles.leave()}
        >
          Cancel
        </Button>
      </fieldset>
    );
  if (call.phase !== "connected") return null;
  return (
    <div className={styles.capsuleWrap}>
      {call.error && (
        <ToastNotice
          title="Agent voice stopped"
          description={call.error}
          closeLabel="Dismiss agent voice error"
          onDismiss={() => {
            if (call.id) huddles.voiceError(call.id);
          }}
        />
      )}
      {presentation.error && (
        <ToastNotice
          title="Couldn’t update Huddle"
          description={presentation.error}
          closeLabel="Dismiss Huddle window error"
          onDismiss={companion.dismissError}
        />
      )}
      <fieldset
        id="huddle-capsule"
        tabIndex={-1}
        className={`${styles.capsule} glass-primary`}
        aria-label="Active Huddle"
      >
        <Button
          variant="ghost"
          size="sm"
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
            <HuddleAvatarStack
              thinking={call.thinking}
              speakers={call.speakers}
              participants={call.participants}
              relay={relay}
              transition
            />
          </span>
        </Button>
        <IconButton
          hint="familiar"
          size="toolbar"
          variant="ghost"
          ref={focus.mute}
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
        <HuddleAudioSettings
          compact
          state={call.audioSettings}
          refresh={huddles.refreshAudioSettings}
          select={huddles.selectAudioDevice}
        />
        <span className={styles.capsuleDivider} aria-hidden="true" />
        <Button
          size="sm"
          variant="destructive"
          data-huddle-leave=""
          style={{ alignSelf: "stretch" }}
          aria-label="Leave huddle"
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
