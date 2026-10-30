import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AgentSaveButton } from "../../../features/agents/AgentSaveButton";
import { ModelFamilyMenu } from "../../../features/agents/ModelFamilyMenu";
import { CaretDownIcon } from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { LoadingRegion } from "../../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../../shared/design-system/ui/PreferenceRow";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverDescription,
} from "../../../shared/design-system/ui/Popover";
import { Select } from "../../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../../shared/design-system/ui/Toast";
import {
  MAX_INSTRUCTIONS_LENGTH,
  validInstructions,
  type AgentClient,
  type RemoteAgent,
  type RemoteAgentModel,
} from "../agents/client";
import type { OAuthSession } from "../oauth/session";
import { effortLabel, modelChoice } from "./models";

const statuses = {
  "setup-required": "Choose a model and thinking level to finish setup.",
  "model-unavailable":
    "The saved model is no longer available. Choose another model and thinking level.",
  "effort-unsupported":
    "The saved thinking level is no longer supported. Choose a supported level.",
  unknown:
    "The server has not confirmed the saved model selection. Choose a model and thinking level.",
};
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Could not load model settings.";

export function ModelSettings({
  client,
  session,
  settings,
}: {
  client: AgentClient;
  session: OAuthSession;
  settings:
    | { agent: RemoteAgent; subject: string }
    | { pending: boolean; error: string; retry(): void };
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const agent = "agent" in settings ? settings.agent : undefined;
  const subject = "subject" in settings ? settings.subject : undefined;
  const form = useId();
  const harnessHelp = useId();
  const [harnessHelpOpen, setHarnessHelpOpen] = useState(false);
  const notify = useToastNotification();
  const [saved, setSaved] = useState(agent);
  const [models, setModels] = useState<readonly RemoteAgentModel[]>();
  const [modelId, setModelId] = useState(agent?.modelId ?? "");
  const [effort, setEffort] = useState(agent?.reasoningEffort ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const busy = !saved || loading || saving || login.status !== "signed-in";
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);
  useEffect(() => {
    if (!agent) return;
    setSaved(agent);
    setModelId(agent.modelId ?? "");
    setEffort(agent.reasoningEffort ?? "");
    setInstructions(agent.instructions ?? "");
  }, [agent]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries a failed catalog request while keeping the draft.
  useEffect(() => {
    if (
      !agent ||
      login.status !== "signed-in" ||
      login.account?.subject !== subject
    )
      return;
    const current = new AbortController();
    setLoading(true);
    setCatalogError("");
    void client
      .modelCatalog(current.signal)
      .then(
        (catalog) => {
          if (!current.signal.aborted) setModels(catalog);
        },
        (reason) => {
          if (!current.signal.aborted) setCatalogError(message(reason));
        },
      )
      .finally(() => {
        if (!current.signal.aborted) setLoading(false);
      });
    return () => current.abort();
  }, [client, agent, revision, login, subject]);
  const model = models?.find((choice) => choice.id === modelId);
  const valid = !!model?.supportedReasoningEfforts.includes(effort);
  const modelChanged =
    modelId !== (saved?.modelId ?? "") ||
    effort !== (saved?.reasoningEffort ?? "");
  const instructionsChanged = instructions !== (saved?.instructions ?? "");
  const saveModel =
    modelChanged ||
    (!instructionsChanged && saved?.modelSelectionStatus !== "valid");
  const disabled =
    login.status !== "signed-in" ||
    !saved ||
    saving ||
    !validInstructions(instructions) ||
    (!instructionsChanged && !saveModel) ||
    (saveModel && (loading || !valid));
  const save = async () => {
    if (disabled || !saved) return;
    const signal = controller.current?.signal;
    if (!signal) return;
    setSaving(true);
    setError("");
    try {
      if (session.credential().account.subject !== subject)
        throw new Error(
          "Sign in to the Builderlab account that loaded these settings.",
        );
      if (saved.status !== "Active")
        throw new Error("Only Active agents can have their settings edited.");
      if (saveModel && instructionsChanged)
        await client.configure(
          saved.pubkey,
          {
            instructions,
            modelId,
            reasoningEffort: effort,
          },
          signal,
        );
      else if (saveModel)
        await client.updateModel(saved, modelId, effort, signal);
      else await client.updateInstructions(saved, instructions, signal);
      signal.throwIfAborted();
      if (!saveModel) {
        setSaved({ ...saved, instructions });
        return;
      }
      const remote = (await client.list(signal)).find(
        (row) => row.pubkey === saved.pubkey,
      );
      signal.throwIfAborted();
      if (!remote)
        throw new Error("Agent not found in this Builderlab account.");
      // Model readback must not replace the instructions draft with an omitted
      // or stale value. Only model fields need server validity confirmation.
      setSaved({ ...remote, instructions });
      setModelId(remote.modelId ?? "");
      setEffort(remote.reasoningEffort ?? "");
      if (remote.modelSelectionStatus === "valid")
        notify("Model preferences saved", "success");
    } catch (reason) {
      if (!signal.aborted) setError(message(reason));
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  };
  const pending =
    login.status === "signed-in" &&
    ("pending" in settings ? settings.pending : loading);
  const [slow, setSlow] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each agent/catalog retry starts a new loading phase, even if pending stays true.
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, [pending, agent, revision]);
  const placeholder =
    login.status === "pending"
      ? "Signing in…"
      : login.status === "signed-out"
        ? "Sign in"
        : pending
          ? slow
            ? "Still loading…"
            : "…"
          : "Unavailable";
  return (
    <LoadingRegion
      pending={pending}
      label={agent ? "Loading models…" : "Loading settings…"}
      statusVisibility="screen-reader"
      feedback={
        "error" in settings && settings.error ? (
          <div className="grid gap-2">
            <p role="alert" className="m-0 text-body-sm text-danger">
              {settings.error}
            </p>
            <div>
              <Button onClick={settings.retry}>Retry</Button>
            </div>
          </div>
        ) : slow && pending ? (
          <div className="grid justify-items-start gap-2">
            <p role="status" className="m-0 text-body-sm text-secondary">
              {agent
                ? "Models are taking longer to load."
                : "Settings are taking longer to load."}
            </p>
            <Button
              onClick={() => {
                if ("retry" in settings) settings.retry();
                else setRevision((value) => value + 1);
              }}
            >
              {agent ? "Retry models" : "Retry"}
            </Button>
          </div>
        ) : undefined
      }
    >
      <form
        id={form}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {saved && saved.modelSelectionStatus !== "valid" && (
          <p role="status" className="m-0 text-body-sm text-warning">
            {statuses[saved.modelSelectionStatus ?? "unknown"]}
            {saved.modelId &&
              ` Saved model: ${models?.find((choice) => choice.id === saved.modelId)?.displayName ?? saved.modelId}.`}
            {saved.reasoningEffort &&
              ` Saved thinking: ${effortLabel(saved.reasoningEffort)}.`}
          </p>
        )}
        <SettingsGroup>
          <PreferenceRow
            title="Harness"
            trailing={
              <div className="buzz-select" data-variant="compact">
                <PopoverRoot
                  open={harnessHelpOpen}
                  onOpenChange={(open, details) => {
                    if (!open && details.reason === "trigger-press") {
                      details.cancel();
                      return;
                    }
                    setHarnessHelpOpen(open);
                  }}
                >
                  <PopoverTrigger
                    openOnHover="preview"
                    nativeButton={false}
                    role="presentation"
                    tabIndex={-1}
                    aria-haspopup={false}
                    aria-expanded={undefined}
                    aria-controls={undefined}
                    onKeyDownCapture={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setHarnessHelpOpen(true);
                      }
                    }}
                    render={
                      <span className="inline-flex">
                        <Button
                          variant="outline"
                          shape="control"
                          size="sm"
                          disabled
                          focusableWhenDisabled
                          aria-label="Harness: Builderlab"
                          aria-haspopup="dialog"
                          aria-expanded={harnessHelpOpen}
                          aria-describedby={
                            harnessHelpOpen ? harnessHelp : undefined
                          }
                          onFocus={() => setHarnessHelpOpen(true)}
                        >
                          Builderlab
                          <CaretDownIcon size={14} aria-hidden="true" />
                        </Button>
                      </span>
                    }
                  />
                  <PopoverPopup
                    side="top"
                    align="end"
                    aria-label="Builderlab harness"
                    initialFocus={false}
                    finalFocus={false}
                  >
                    <PopoverDescription id={harnessHelp}>
                      Builderlab holds this agent’s signing key. Buzz can’t move
                      that identity to a local harness yet. To run locally,
                      create a new agent.
                    </PopoverDescription>
                  </PopoverPopup>
                </PopoverRoot>
              </div>
            }
          />
          <ModelFamilyMenu
            label="Model"
            align="end"
            selected={
              model
                ? modelChoice(model)
                : {
                    id: "",
                    label: models?.length ? "Choose a model" : placeholder,
                  }
            }
            models={(models ?? []).map(modelChoice)}
            disabled={busy || !models?.length}
            onChange={(next) => {
              setModelId(next);
              setEffort("");
            }}
          />
          <Select
            label="Thinking"
            variant="preference"
            align="end"
            value={valid ? effort : ""}
            placeholder={models?.length ? "Choose thinking" : placeholder}
            disabled={busy || !model}
            groups={[
              {
                label: "",
                options: (model?.supportedReasoningEfforts ?? []).map(
                  (value) => ({ value, label: effortLabel(value) }),
                ),
              },
            ]}
            onValueChange={setEffort}
          />
        </SettingsGroup>
        {models?.length === 0 && (
          <p className="m-0 text-body-sm text-secondary">
            No models are available. Retry when the catalog is available.
          </p>
        )}
        <Field
          label="Instructions"
          error={
            !validInstructions(instructions)
              ? "Use text or leave this empty."
              : undefined
          }
        >
          <Textarea
            appearance="outlined"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            disabled={!saved || saving}
            placeholder={!saved ? placeholder : undefined}
            rows={8}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
          />
        </Field>
        <AgentSaveButton
          form={form}
          saving={saving}
          disabled={disabled}
          dirty={modelChanged || instructionsChanged}
        />
        {(catalogError || error) && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error || catalogError}
          </p>
        )}
        {(catalogError || error || models?.length === 0) && (
          <div>
            <Button
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              {catalogError || models?.length === 0
                ? "Retry models"
                : "Refresh models"}
            </Button>
          </div>
        )}
      </form>
    </LoadingRegion>
  );
}
