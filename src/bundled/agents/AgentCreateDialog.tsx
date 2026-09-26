import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import type { AgentProviders } from "../../features/agents/providers";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft, agentEdit, type AgentDraft } from "./agent-edit";

const none: ReturnType<AgentProviders["snapshot"]> = [];
const noProviders: AgentProviders = {
  snapshot: () => none,
  subscribe: () => () => {},
  register: () => {},
};

export function AgentCreateDialog({
  control,
  state,
  destination,
  owner,
  source,
  providers = noProviders,
  onClose,
}: {
  control: AgentControl;
  providers?: AgentProviders;
  state: AgentControlState;
  destination: string;
  owner: string;
  source?: AgentView;
  onClose(): void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<AgentDraft>(() =>
    source
      ? {
          ...agentDraft(source),
          name: `${source.name} copy`,
        }
      : {
          revision: 0,
          name: "",
          systemPrompt: "",
          workspace: state.data?.defaultWorkspace ?? "",
          command: "buzz-agent",
          args: "[]",
          model: "",
          provider: state.data?.agentDefaults?.provider ? "" : "databricks_v2",
          environment: {},
        },
  );
  const providerChoices = useSyncExternalStore(
    providers.subscribe,
    providers.snapshot,
    providers.snapshot,
  );
  // "" keeps the ACP harness path; otherwise the chosen provider's contribution key.
  const [providerKey, setProviderKey] = useState("");
  const [providerConfig, setProviderConfig] = useState<Record<string, string>>(
    {},
  );
  const provider = source
    ? undefined
    : providerChoices.find((entry) => entry.key === providerKey);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<AgentView | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available = !!(
    destination &&
    owner &&
    state.data?.createAvailable &&
    control.create
  );
  const runtimeBlocked = !state.data?.runtimeAvailable && !saved;
  const blocked = busy || state.busy || state.status !== "ready";
  const create = async () => {
    if (blocked || runtimeBlocked || !available || !control.create) return;
    // A provider that disappears mid-dialog must not fall back to a harness agent.
    if (providerKey && !source && !provider && !saved) {
      setError("That provider is no longer enabled.");
      return;
    }
    if (provider && !saved && !draft.name.trim()) {
      setError("Enter an agent name.");
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const agent =
        saved ??
        (provider
          ? await control.create(
              requestId,
              destination,
              owner,
              {
                name: draft.name,
                systemPrompt: "",
                workspace: draft.workspace,
                // Never launched: native refuses to start provider-backed agents.
                harness: {
                  command: provider.key,
                  args: [],
                  model: "",
                  provider: "",
                },
                environment: {},
              },
              { provider: provider.key, config: providerConfig },
            )
          : await control.create(
              requestId,
              destination,
              owner,
              agentEdit(draft),
            ));
      // Closing leaves native creation alone; the saved card owns profile retry.
      if (!mounted.current) return;
      setDraft((current) => ({ ...current, environment: {} }));
      setSaved(agent); // Durable local success survives a failed profile publication.
      const current = state.data?.agents.find((item) => item.id === agent.id);
      if (saved && current && !current.profilePending) {
        onClose();
        return;
      }
      if (!control.publishProfile)
        throw new Error("Agent saved; rebuild desktop to publish its profile.");
      await control.publishProfile(agent.id);
      if (mounted.current) onClose();
    } catch (problem) {
      if (mounted.current)
        setError(
          problem instanceof Error
            ? problem.message
            : "Could not finish creation. Your draft is retained.",
        );
    } finally {
      if (mounted.current) setBusy(false);
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
        <Dialog.Backdrop data-buzz-ui="" className="buzz-dialog-backdrop" />
        <Dialog.Popup
          data-buzz-ui=""
          className="buzz-dialog agent-dialog text-body"
        >
          <header className="buzz-dialog-header">
            <Dialog.Title className="text-heading">
              {source ? `Duplicate ${source.name}` : "Create agent"}
            </Dialog.Title>
          </header>
          <Dialog.Description className="buzz-dialog-description">
            Create a new identity in {destination || "a connected community"}.
            It stays stopped until you start it or send it a mention. No channel
            is joined automatically.
          </Dialog.Description>
          <form
            className="buzz-dialog-body space-y-section-gap"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            {!source && providerChoices.length > 0 && (
              <Field label="Runs with">
                <RadioGroup
                  value={providerKey}
                  disabled={blocked || !!saved}
                  onValueChange={(value) => {
                    const key = String(value);
                    setProviderKey(key);
                    setProviderConfig({
                      ...(providerChoices.find((entry) => entry.key === key)
                        ?.defaultConfig ?? {}),
                    });
                    setDirty(true);
                    setError(undefined);
                  }}
                >
                  <Radio
                    value=""
                    variant="card"
                    label="Agent harness"
                    description="Runs a local harness through the bundled ACP runtime."
                  />
                  {providerChoices.map((entry) => (
                    <Radio
                      key={entry.key}
                      value={entry.key}
                      variant="card"
                      label={entry.title}
                      description={entry.description}
                    />
                  ))}
                </RadioGroup>
              </Field>
            )}
            {provider ? (
              <>
                <Field label="Name">
                  <Input
                    disabled={blocked || !!saved}
                    value={draft.name}
                    onChange={(event) => {
                      setDraft({ ...draft, name: event.target.value });
                      setDirty(true);
                      setError(undefined);
                    }}
                  />
                </Field>
                {provider.setup && (
                  <provider.setup
                    value={providerConfig}
                    disabled={blocked || !!saved}
                    onChange={(value) => {
                      setProviderConfig({ ...value });
                      setDirty(true);
                      setError(undefined);
                    }}
                  />
                )}
              </>
            ) : (
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
            )}
            {source?.harness.environmentKeys.length ? (
              <p role="status" className="text-body-sm text-secondary">
                Re-enter environment values for{" "}
                {source.harness.environmentKeys.join(", ")}. Saved values cannot
                be copied into a new identity.
              </p>
            ) : null}
            {!available && (
              <p role="status">
                Connect to a community and use a rebuilt desktop app to create
                an agent.
              </p>
            )}
            {runtimeBlocked && (
              <p role="alert">
                This app’s agent runtime is unavailable. Repair or rebuild the
                desktop app before creating an agent.
                {state.data?.runtimeMessage && ` ${state.data.runtimeMessage}`}
              </p>
            )}
            {busy && (
              <p role="status">
                You can close this dialog to stop another agent. Saving
                continues; refresh status afterward to recover the saved agent
                and retry its profile.
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
            <div className="buzz-dialog-actions">
              <Button onClick={onClose}>
                {busy || saved ? "Close" : "Cancel"}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={blocked || runtimeBlocked || !available}
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
