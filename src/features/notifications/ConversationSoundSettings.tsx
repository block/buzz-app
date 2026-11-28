import { useEffect, useRef, useSyncExternalStore } from "react";
import type { NavigationScope } from "../navigation/targets";
import type { NotificationsService } from "./service";
import { conversationSoundKey } from "./preferences";
import {
  createNotificationSoundPlayback,
  isSoundName,
  SOUND_NAMES,
  type NotificationSoundPlayback,
  type SoundName,
} from "./sound";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";

/** Personal sound only: never changes channel metadata or alert eligibility. */
export function ConversationSoundSettings({
  notifications,
  scope,
  channelId,
  active = true,
}: {
  notifications: NotificationsService;
  scope: NavigationScope;
  channelId: string;
  active?: boolean;
}) {
  const state = useSyncExternalStore(
    notifications.subscribe,
    notifications.snapshot,
  );
  const key = conversationSoundKey(scope.communityOrigin, channelId);
  const value = state.preferences.conversationSounds[key] ?? "default";
  const currentViewer = state.viewer === scope.viewer;
  const canPreview =
    active &&
    currentViewer &&
    !state.developmentPaused &&
    state.preferences.enabled &&
    state.preferences.sound;
  const preview = useRef<{
    name: SoundName;
    audio: NotificationSoundPlayback;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the service, conversation or account must cancel its preview, even when the selected sound is unchanged.
  useEffect(
    () => () => {
      preview.current?.audio.stop();
      preview.current = null;
    },
    [notifications, key, scope.viewer],
  );
  useEffect(() => {
    if (!canPreview || preview.current?.name !== value) {
      preview.current?.audio.stop();
      preview.current = null;
    }
  }, [canPreview, value]);

  return (
    <section aria-label="Conversation notifications">
      <SettingsGroup>
        <PreferenceRow
          title="Notification sound"
          subtitle="Only for this conversation, on this device. Choose a sound to preview it. This doesn’t enable additional alerts."
          disabled={!currentViewer}
          trailing={({ "aria-describedby": describedBy }) => (
            <Select
              label="Notification sound"
              variant="compact"
              describedBy={describedBy}
              disabled={!currentViewer}
              value={value}
              groups={[
                {
                  label: "",
                  options: [
                    { value: "default", label: "Use default" },
                    { value: "silent", label: "Silent" },
                    ...SOUND_NAMES.map((name) => ({
                      value: name,
                      label: name,
                    })),
                  ],
                },
              ]}
              onValueChange={(next) => {
                if (
                  next === value ||
                  (next !== "default" && !isSoundName(next))
                )
                  return;
                preview.current?.audio.stop();
                preview.current = null;
                const sound = isSoundName(next) ? next : undefined;
                notifications.setConversationSound(scope, channelId, sound);
                // Persistence failure keeps the choice active and reports it below.
                const latest = notifications.snapshot();
                if (
                  !active ||
                  latest.viewer !== scope.viewer ||
                  latest.developmentPaused ||
                  !latest.preferences.enabled ||
                  !latest.preferences.sound ||
                  !sound
                )
                  return;
                const audio = createNotificationSoundPlayback(sound);
                if (!audio) return;
                preview.current = { name: sound, audio };
                void audio.finished.then(() => {
                  if (preview.current?.audio === audio) preview.current = null;
                });
              }}
            />
          )}
        />
      </SettingsGroup>
      {currentViewer && state.preferencesError && (
        <p role="alert" className="text-body-sm text-danger">
          {state.preferencesError}{" "}
          <Button
            type="button"
            size="sm"
            variant="link"
            onClick={() =>
              notifications.setConversationSound(
                scope,
                channelId,
                value === "default" ? undefined : value,
              )
            }
          >
            Retry saving
          </Button>{" "}
          <Button
            type="button"
            size="sm"
            variant="link"
            onClick={() => notifications.reloadPreferences()}
          >
            Reload saved choices
          </Button>
        </p>
      )}
    </section>
  );
}
