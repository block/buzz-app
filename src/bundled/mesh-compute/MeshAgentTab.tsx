import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AgentViewProps } from "../../features/agents/service";
import { communityDestination } from "../../features/communities/destination";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  DEFAULT_WORKSPACE,
  type MeshAgentConfig,
  type MeshMode,
  meshAgentConfig,
  validWorkspace,
} from "./meshAgent";
import { MESH_AGENT_PRESETS } from "./meshAgentPresets";
import { type Inventory, modelLabel } from "./CommunityMesh";

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
const MODES = options([
  ["chat", "Chat"],
  ["agent", "Agent"],
]);
const MODE_DESCRIPTIONS: Record<MeshMode, string> = {
  chat: "Answers from the conversation alone, with no tools. Suits small models.",
  agent: "Works with shell, project skills and Buzz tools.",
};
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);
const CUSTOM = "custom";
const PRESETS = options([
  [CUSTOM, "Custom"],
  ...MESH_AGENT_PRESETS.map((preset) => [preset.id, preset.name] as const),
]);

const AUTO = "auto";
type ModelChoice = { id: string; label: string; members: number };

/** One choice per advertised model ref, with how many members share it. */
export function modelChoices(entries: Inventory["entries"]): ModelChoice[] {
  const models = new Map<string, { label: string; members: Set<string> }>();
  for (const entry of entries) {
    const model = models.get(entry.modelId) ?? {
      label: modelLabel(entry.modelName || entry.modelId),
      members: new Set<string>(),
    };
    model.members.add(entry.memberPubkey);
    models.set(entry.modelId, model);
  }
  return [...models]
    .map(([id, { label, members }]) => ({ id, label, members: members.size }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Models the agent's community is advertising now; signed relay adverts,
 * not live node health. Empty outside the desktop app or on failure. */
function useCommunityModels(relay: string) {
  const [models, setModels] = useState<ModelChoice[]>();
  useEffect(() => {
    let active = true;
    if (!isTauri()) {
      setModels([]);
      return;
    }
    invoke<Inventory>("mesh_compute_inventory", {
      community: communityDestination(relay).url,
    })
      .then((inventory) => modelChoices(inventory.entries))
      .catch(() => [])
      .then((choices) => {
        if (active) setModels(choices);
      });
    return () => {
      active = false;
    };
  }, [relay]);
  return models;
}

/** The Mesh type's settings: a starting preset, prompt, mode, sessions and
 * working directory, with an optional fixed model under Advanced. */
export function MeshAgentTab({ agent, save }: AgentViewProps<MeshAgentConfig>) {
  const saved = meshAgentConfig(agent.config);
  const [draft, setDraft] = useState(saved);
  const models = useCommunityModels(agent.relay);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const workspaceValid = validWorkspace(draft.workspace);
  const changed =
    draft.prompt !== saved.prompt ||
    draft.workspace.trim() !== saved.workspace ||
    draft.mode !== saved.mode ||
    draft.scope !== saved.scope ||
    draft.preset !== saved.preset ||
    draft.model !== saved.model;
  const preset = MESH_AGENT_PRESETS.find((item) => item.id === draft.preset);
  const shared = models ?? [];
  const missing =
    draft.model && !shared.some((model) => model.id === draft.model)
      ? draft.model
      : undefined;
  const modelGroups = options([
    [AUTO, "Auto (recommended)"],
    ...shared.map(
      (model) =>
        [
          model.id,
          model.members > 1
            ? `${model.label} · ${model.members} sharing`
            : model.label,
        ] as const,
    ),
    ...(missing
      ? [
          [
            missing,
            `${modelLabel(missing)} · ${models ? "not shared now" : "checking…"}`,
          ] as const,
        ]
      : []),
  ]);
  const submit = async () => {
    if (!changed || saving || !workspaceValid) return;
    setSaving(true);
    setError(undefined);
    try {
      await save({ ...draft, workspace: draft.workspace.trim() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Select
        label="Start from"
        variant="field"
        value={draft.preset ?? CUSTOM}
        groups={PRESETS}
        description={
          preset?.summary ??
          "Pick an example to fill the prompt and mode, then edit as you like."
        }
        onValueChange={(value) => {
          const picked = MESH_AGENT_PRESETS.find((item) => item.id === value);
          if (!picked) {
            const { preset: _, ...rest } = draft;
            setDraft(rest);
            return;
          }
          setDraft({
            ...draft,
            preset: picked.id,
            prompt: picked.prompt,
            mode: picked.mode,
          });
        }}
      />
      <Field
        label="Prompt"
        description="The system prompt for every reply. Replies come from this community's shared compute."
      >
        <Textarea
          rows={8}
          value={draft.prompt}
          onChange={(event) =>
            setDraft({ ...draft, prompt: event.target.value })
          }
        />
      </Field>
      <Select
        label="Mode"
        variant="field"
        value={draft.mode}
        groups={MODES}
        description={MODE_DESCRIPTIONS[draft.mode]}
        onValueChange={(value) =>
          setDraft({
            ...draft,
            mode: value === "chat" ? "chat" : "agent",
          })
        }
      />
      <Select
        label="Sessions"
        variant="field"
        value={draft.scope}
        groups={SCOPES}
        onValueChange={(value) =>
          setDraft({
            ...draft,
            scope: value === "channel" ? "channel" : "thread",
          })
        }
      />
      {draft.mode !== "chat" && (
        <Field
          label="Workspace"
          description={`Where its shell runs, and where it finds project skills. An absolute path, or ${DEFAULT_WORKSPACE}.`}
          error={workspaceValid ? undefined : "Use an absolute path."}
        >
          <Input
            value={draft.workspace}
            onChange={(event) =>
              setDraft({ ...draft, workspace: event.target.value })
            }
          />
        </Field>
      )}
      <Accordion
        variant="form"
        keepMounted
        defaultValue={saved.model ? ["advanced"] : []}
        items={[
          {
            value: "advanced",
            title: "Advanced",
            content: (
              <Select
                label="Model"
                variant="field"
                value={draft.model ?? AUTO}
                groups={modelGroups}
                {...(draft.model ? { valueTitle: draft.model } : {})}
                description={
                  missing && models
                    ? "No one in this community is sharing this model right now, so replies will fail until someone does. Choose Auto to use whatever is shared."
                    : draft.model
                      ? "Every reply asks for this model, and fails if no one is sharing it."
                      : models && !shared.length
                        ? "Auto lets Mesh pick a shared model for each reply. No models are being shared right now."
                        : "Auto lets Mesh pick a shared model for each reply. Choose one to always use it."
                }
                onValueChange={(value) => {
                  const { model: _, ...rest } = draft;
                  setDraft(value === AUTO ? rest : { ...rest, model: value });
                }}
              />
            ),
          },
        ]}
      />
      {error && (
        <p role="alert" className="buzz-field-error">
          {error}
        </p>
      )}
      <div>
        <Button
          type="submit"
          variant="prominent"
          loading={saving}
          disabled={!changed || !workspaceValid}
          focusableWhenDisabled
        >
          Save
        </Button>
      </div>
    </form>
  );
}
