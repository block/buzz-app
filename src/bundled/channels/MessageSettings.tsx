import {
  setThreadPlacementPreference,
  useThreadPlacementPreference,
} from "../../features/messages/thread-preferences";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  useFollowUpBehaviorPreference,
  setFollowUpBehaviorPreference,
} from "../../features/messages/follow-up-preference";

/** Registered by Messages; its settings presentation follows plugin lifetime. */
export function MessageSettings({ active }: { active(): boolean }) {
  const { placement, unsaved } = useThreadPlacementPreference();
  const followUp = useFollowUpBehaviorPreference();
  return (
    <section aria-label="Messages settings">
      <Header title="Messages" />
      <SettingsGroup>
        <PreferenceRow
          title="Follow-up behavior"
          subtitle="In Solo, send follow-ups immediately or queue them until the agent finishes its previous response."
          trailing={
            <Select
              variant="compact"
              label="Follow-up behavior"
              value={followUp.behavior}
              groups={[
                {
                  label: "Behavior",
                  options: [
                    { value: "immediate", label: "Send immediately" },
                    { value: "queue", label: "Queue" },
                  ],
                },
              ]}
              onValueChange={(value) => {
                if (value === "immediate" || value === "queue")
                  setFollowUpBehaviorPreference(value);
              }}
            />
          }
        />
        <PreferenceRow
          title="Open threads in"
          subtitle="New threads open here. Already-open threads stay where you placed them."
          trailing={
            <Select
              variant="compact"
              label="Open threads in"
              value={placement}
              groups={[
                {
                  label: "Pane",
                  options: [
                    { value: "side", label: "Side pane" },
                    { value: "main", label: "Main pane" },
                  ],
                },
              ]}
              onValueChange={(value) => {
                if (value === "main" || value === "side")
                  setThreadPlacementPreference(value);
              }}
            />
          }
        />
      </SettingsGroup>
      {active() && followUp.unsaved && (
        <ToastNotice
          title="Follow-up preference wasn’t saved"
          description="This choice is active, but could not be saved on this device."
        >
          <Button
            size="sm"
            onClick={() => setFollowUpBehaviorPreference(followUp.behavior)}
          >
            Retry saving
          </Button>
        </ToastNotice>
      )}
      {active() && unsaved && (
        <ToastNotice
          title="Thread preference wasn’t saved"
          description="This choice is active, but could not be saved on this device. Try again."
        >
          <Button
            type="button"
            size="sm"
            onClick={() => setThreadPlacementPreference(placement)}
          >
            Retry saving
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
