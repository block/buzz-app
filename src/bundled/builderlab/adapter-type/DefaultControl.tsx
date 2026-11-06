import { useEffect, useState, useSyncExternalStore } from "react";
import { ModelPicker } from "../../../features/agents/ModelPicker";
import { Button } from "../../../shared/design-system/ui/Button";
import type { AgentClient, RemoteAgentModelCatalog } from "../agents/client";
import type { BuilderlabSession } from "../session";
import type { BuilderlabDefaults } from "./defaults";
import { effortLabel, modelChoice } from "./models";

export function createDefaultControl(
  client: AgentClient,
  session: BuilderlabSession,
  defaults: BuilderlabDefaults,
) {
  return function DefaultControl() {
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    useSyncExternalStore(defaults.subscribe, defaults.snapshot);
    const [catalog, setCatalog] = useState<
      RemoteAgentModelCatalog & { login: typeof login }
    >();
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    const loaded = catalog?.login === login ? catalog : undefined;
    // biome-ignore lint/correctness/useExhaustiveDependencies: retry reloads a failed catalog.
    useEffect(() => {
      if (login.status !== "signed-in" || !login.account?.canUseRemoteAgents)
        return;
      const controller = new AbortController();
      setCatalog(undefined);
      setError("");
      void client.modelCatalog(controller.signal).then(
        (next) => {
          if (!controller.signal.aborted) setCatalog({ ...next, login });
        },
        (reason) => {
          if (!controller.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not load models.",
            );
        },
      );
      return () => controller.abort();
    }, [client, login, retry]);
    const subject = login.account?.subject;
    const selected =
      subject && loaded ? defaults.resolve(subject, loaded) : undefined;
    const save = (modelId: string, reasoningEffort: string) => {
      if (!subject || session.snapshot() !== login || !loaded) return;
      if (
        modelId &&
        !loaded.models
          .find((model) => model.id === modelId)
          ?.supportedReasoningEfforts.includes(reasoningEffort)
      )
        return;
      try {
        defaults.save(
          subject,
          modelId ? { modelId, reasoningEffort } : undefined,
        );
        setError("");
      } catch {
        setError("Could not save the Builderlab default. Try again.");
      }
    };
    return (
      <>
        <ModelPicker
          compact
          groupByFamily
          includeDefault={false}
          label={`Builderlab default model${selected ? `, ${effortLabel(selected.reasoningEffort)} thinking` : ""}`}
          resetLabel="Use Builderlab recommended"
          value={selected?.modelId ?? ""}
          defaultLabel="Choose a model"
          effort={selected?.reasoningEffort}
          models={(loaded?.models ?? []).map((model) => ({
            ...modelChoice(model),
            efforts: model.supportedReasoningEfforts.map((id) => ({
              id,
              label: effortLabel(id),
            })),
          }))}
          loading={!loaded && !error}
          disabled={
            !subject ||
            login.status !== "signed-in" ||
            !login.account?.canUseRemoteAgents
          }
          onEffortChange={save}
          onChange={(id) => {
            if (!id) save("", "");
          }}
        />
        {(error || loaded?.models.length === 0) && (
          <>
            <span role="alert" className="text-body-sm text-danger">
              {error || "No models are available."}
            </span>
            <Button size="sm" onClick={() => setRetry((value) => value + 1)}>
              Retry models
            </Button>
          </>
        )}
      </>
    );
  };
}
