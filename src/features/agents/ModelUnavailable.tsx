import { useEffect, useState, useSyncExternalStore } from "react";
import type { ComposerAccessoryProps } from "../conversation/contracts";
import { ModelPicker, type ModelChoice } from "./ModelPicker";
import { pubkeyOf } from "./membership";
import { routeOf } from "./model-routes";
import {
  offRecommended,
  onRecommended,
  type RecommendedCandidate,
} from "./recommended";
import type { Agents, Models } from "./service";

/** Under one of the viewer's own agents' replies saying a turn failed because
 * its provider does not have its model: a menu of the models the agent can
 * run on. A pick is saved to that agent's own settings, never to its harness's
 * shared config, so only its next turns change. Nothing is shown for anyone
 * else's agent, or once the agent no longer runs on that model, unless it was
 * picked here. */
export function ModelUnavailable({
  agents,
  message,
}: Pick<ComposerAccessoryProps, "message"> & { agents: PickerAgents }) {
  // Every other message renders nothing and follows no agent changes.
  return message?.modelUnavailable ? (
    <Picker
      agents={agents}
      author={message.authorId}
      failed={message.modelUnavailable}
    />
  ) : null;
}

type PickerAgents = Pick<
  Agents,
  "subscribe" | "snapshot" | "find" | "types" | "save"
>;

function Picker({
  agents,
  author,
  failed,
}: {
  agents: PickerAgents;
  author: string;
  failed: string;
}) {
  useSyncExternalStore(agents.subscribe, agents.snapshot, agents.snapshot);
  const found = agents.find(author);
  // Only an agent here has config to save.
  const agent =
    found?.place === "here" && !found.configProblem && !found.deleting
      ? found
      : undefined;
  const type = agent && agents.types().find((item) => item.key === agent.type);
  const [listed, setListed] = useState<{
    models: Models;
    recommended: RecommendedCandidate | null | undefined;
  }>();
  const [picked, setPicked] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = agent?.key;
  const config = agent?.config;
  const remote = Boolean(agent?.executionBinding);
  // Listed again once a pick is saved, so the menu shows what it runs on. The
  // previous list stays meanwhile.
  useEffect(() => {
    const current = key && agents.find(pubkeyOf(key));
    // Only the config this render shows; a newer one lists on its own render.
    if (!current || current.config !== config || !type?.models) return;
    let live = true;
    const listModels = type.models;
    void (async () => {
      const resolve =
        onRecommended(current.config) && !remote
          ? type.settingsProposal?.resolveRecommended
          : undefined;
      const recommended = resolve
        ? await resolve().catch(() => null)
        : undefined;
      if (!live) return;
      const models = await listModels(current);
      if (live) setListed({ models, recommended });
    })().catch((reason: unknown) =>
      console.warn(`Agent type ${type.key} could not list its models`, reason),
    );
    return () => {
      live = false;
    };
  }, [agents, key, config, remote, type]);
  if (!agent || !type || !listed) return null;
  if (picked === undefined && listed.models.current !== failed) return null;
  const choices: ModelChoice[] = listed.models.models
    .filter((model) => model.id !== failed)
    .map(({ id, label }) => ({ id, label }));
  if (!choices.length) return null;
  const save = async (model: string) => {
    if (!model || model === failed) return;
    setSaving(true);
    setError("");
    try {
      const base = offRecommended(agent.config as Record<string, unknown>);
      const effort = typeof base.effort === "string" ? base.effort : "";
      const chosen = listed.models.models.find((item) => item.id === model);
      const clearEffort =
        effort !== "" &&
        (Boolean(routeOf(model)) ||
          !chosen?.efforts.some((level) => level.id === effort));
      const provider =
        onRecommended(agent.config) && listed.recommended?.provider
          ? listed.recommended.provider
          : undefined;
      await agents.save(agent.key, {
        config: {
          ...base,
          ...(provider ? { provider } : {}),
          model,
          ...(clearEffort ? { effort: "" } : {}),
        },
        ...(agent.configBase && { base: agent.configBase }),
      });
      setPicked(model);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <span className="text-body-sm text-subtle">
          {picked
            ? `${agent.name} uses this model from now on.`
            : `Pick a model for ${agent.name}:`}
        </span>
        <ModelPicker
          compact
          groupByFamily
          harness={type.id}
          label={`Model for ${agent.name}`}
          includeDefault={false}
          models={choices}
          value={picked ?? failed}
          defaultLabel={failed}
          pending={saving}
          onChange={(model) => void save(model)}
        />
      </div>
      {error && (
        <p role="alert" className="buzz-field-error m-0">
          {error}
        </p>
      )}
    </div>
  );
}
