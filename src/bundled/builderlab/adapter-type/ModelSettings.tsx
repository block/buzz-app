import { useEffect, useId, useRef, useState } from "react";
import { AgentSaveButton } from "../../../features/agents/AgentSaveButton";
import { ModelFamilyMenu } from "../../../features/agents/ModelFamilyMenu";
import { CaretDownIcon } from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { PreferenceRow } from "../../../shared/design-system/ui/PreferenceRow";
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
import { modelChoice } from "./models";

const effortLabel = (id: string) =>
  id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

const statuses = {
  "setup-required": "Choose a model and reasoning effort to finish setup.",
  "model-unavailable":
    "The saved model is no longer available. Choose another model and reasoning effort.",
  "effort-unsupported":
    "The saved reasoning effort is no longer supported. Choose a supported effort.",
  unknown:
    "The server has not confirmed the saved model selection. Choose a model and reasoning effort.",
};
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Could not load model settings.";

export function ModelSettings({
  client,
  session,
  agent,
  subject,
}: {
  client: AgentClient;
  session: OAuthSession;
  agent: RemoteAgent;
  subject: string;
}) {
  const form = useId();
  const notify = useToastNotification();
  const [saved, setSaved] = useState(agent);
  const [models, setModels] = useState<readonly RemoteAgentModel[]>();
  const [modelId, setModelId] = useState(agent.modelId ?? "");
  const [effort, setEffort] = useState(agent.reasoningEffort ?? "");
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const busy = loading || saving;
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries a failed catalog request while keeping the draft.
  useEffect(() => {
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
  }, [client, revision]);
  const model = models?.find((choice) => choice.id === modelId);
  const valid = !!model?.supportedReasoningEfforts.includes(effort);
  const modelChanged =
    modelId !== (saved.modelId ?? "") ||
    effort !== (saved.reasoningEffort ?? "");
  const instructionsChanged = instructions !== (saved.instructions ?? "");
  const saveModel =
    modelChanged ||
    (!instructionsChanged && saved.modelSelectionStatus !== "valid");
  const disabled =
    saving ||
    !validInstructions(instructions) ||
    (!instructionsChanged && !saveModel) ||
    (saveModel && (loading || !valid));
  const save = async () => {
    if (disabled) return;
    const signal = controller.current?.signal;
    if (!signal) return;
    setSaving(true);
    setError("");
    try {
      await session.ensureSignedIn(signal);
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
  return (
    <form
      id={form}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {saved.modelSelectionStatus !== "valid" && (
        <p role="status" className="m-0 text-body-sm text-warning">
          {statuses[saved.modelSelectionStatus ?? "unknown"]}
          {saved.modelId &&
            ` Saved model: ${models?.find((choice) => choice.id === saved.modelId)?.displayName ?? saved.modelId}.`}
          {saved.reasoningEffort &&
            ` Saved effort: ${effortLabel(saved.reasoningEffort)}.`}
        </p>
      )}
      <SettingsGroup>
        <PreferenceRow
          title="Harness"
          trailing={
            <div className="buzz-select" data-variant="compact">
              <Button
                variant="outline"
                shape="control"
                size="sm"
                disabled
                focusableWhenDisabled
                aria-label="Harness: Builderlab"
                title="This agent can’t currently be moved out of its Builderlab instance."
              >
                Builderlab
                <CaretDownIcon size={14} aria-hidden="true" />
              </Button>
            </div>
          }
        />
        {!!models?.length && (
          <>
            <ModelFamilyMenu
              label="Model"
              align="end"
              selected={
                model ? modelChoice(model) : { id: "", label: "Choose a model" }
              }
              models={models.map(modelChoice)}
              disabled={busy}
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
              placeholder="Choose thinking"
              disabled={busy || !model}
              groups={[
                {
                  label: "Supported reasoning efforts",
                  options: (model?.supportedReasoningEfforts ?? []).map(
                    (value) => ({ value, label: effortLabel(value) }),
                  ),
                },
              ]}
              onValueChange={setEffort}
            />
          </>
        )}
      </SettingsGroup>
      {models
        ? !models.length && (
            <p className="m-0 text-body-sm text-secondary">
              No models are available. Retry when the catalog is available.
            </p>
          )
        : loading && (
            <p className="m-0 text-body-sm text-secondary">Loading models…</p>
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
          disabled={saving}
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
  );
}
