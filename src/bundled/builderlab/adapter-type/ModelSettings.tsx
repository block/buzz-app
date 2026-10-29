import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AgentSaveButton } from "../../../features/agents/AgentSaveButton";
import { ModelFamilyMenu } from "../../../features/agents/ModelFamilyMenu";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { LoadingRegion } from "../../../shared/design-system/ui/LoadingRegion";
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
  harnessControl,
}: {
  client: AgentClient;
  session: OAuthSession;
  harnessControl?: ReactNode;
  settings:
    | { agent: RemoteAgent; subject: string }
    | { pending: boolean; error: string; retry(): void };
}) {
  const agent = "agent" in settings ? settings.agent : undefined;
  const subject = "subject" in settings ? settings.subject : undefined;
  const form = useId();
  const notify = useToastNotification();
  const [saved, setSaved] = useState(agent);
  const [models, setModels] = useState<readonly RemoteAgentModel[]>();
  const [modelId, setModelId] = useState(agent?.modelId ?? "");
  const [effort, setEffort] = useState(agent?.reasoningEffort ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const busy = !saved || loading || saving;
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
    if (!agent) return;
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
  }, [client, agent, revision]);
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
  const pending = "pending" in settings ? settings.pending : loading;
  const placeholder = pending ? "…" : "Unavailable";
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
          {harnessControl ?? (
            <PreferenceRow title="Harness" trailing="Builderlab" />
          )}
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
