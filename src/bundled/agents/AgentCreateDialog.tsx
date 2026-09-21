import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentEdit, type AgentDraft } from "./agent-edit";

export function AgentCreateDialog({
  control,
  state,
  destination,
  owner,
  onClose,
}: {
  control: AgentControl;
  state: AgentControlState;
  destination: string;
  owner: string;
  onClose(): void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<AgentDraft>(() => ({
    revision: 0,
    name: "",
    systemPrompt: "",
    workspace: state.data?.defaultWorkspace ?? "",
    command: "buzz-agent",
    args: "[]",
    model: "",
    provider: "databricks_v2",
    environment: {},
    ...(state.data?.databricksDefaults
      ? { databricks: { ...state.data.databricksDefaults } }
      : {}),
  }));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<AgentView | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const available = !!(
    destination &&
    owner &&
    state.data?.createAvailable &&
    control.create
  );
  const blocked = busy || state.busy || state.status !== "ready";
  const create = async () => {
    if (blocked || !available || !control.create) return;
    setError(undefined);
    setBusy(true);
    try {
      const agent =
        saved ??
        (await control.create(requestId, destination, owner, agentEdit(draft)));
      setSaved(agent); // Durable local success survives a failed profile publication.
      const current = state.data?.agents.find((item) => item.id === agent.id);
      if (saved && current && !current.profilePending) {
        onClose();
        return;
      }
      if (!control.publishProfile)
        throw new Error("Agent saved; rebuild desktop to publish its profile.");
      await control.publishProfile(agent.id);
      onClose();
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not finish creation. Your draft is retained.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !dirty && !blocked) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="agent-dialog-backdrop" />
        <Dialog.Popup
          data-buzz-ui=""
          className="agent-controls agent-dialog text-body"
        >
          <Dialog.Title className="text-heading">Create agent</Dialog.Title>
          <Dialog.Description className="text-body-sm text-secondary">
            Create a new identity in {destination || "a connected community"}.
            It stays stopped until you start it or send it a mention. No channel
            is joined automatically.
          </Dialog.Description>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <AgentSettingsFields
              draft={draft}
              control={control}
              state={state}
              disabled={blocked || !!saved}
              onChange={(patch) => {
                setDraft({ ...draft, ...patch });
                setDirty(true);
                setError(undefined);
              }}
            />
            {!available && (
              <p role="status">
                Connect to a community and use a rebuilt desktop app to create
                an agent.
              </p>
            )}
            {saved && (
              <p role="status">
                {saved.name} is saved and stopped. Its profile is not confirmed
                yet; Retry uses this same identity. You can also close and retry
                from its card.
              </p>
            )}
            {(error || state.error) && (
              <p role="alert">{state.error ?? error}</p>
            )}
            {state.status === "error" && (
              <Button onClick={() => void control.refresh()}>
                Retry status
              </Button>
            )}
            <div className="flex justify-end gap-2">
              <Button disabled={busy || state.busy} onClick={onClose}>
                {saved ? "Close" : "Cancel"}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={blocked || !available}
              >
                {busy ? "Saving…" : saved ? "Retry profile" : "Create agent"}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
