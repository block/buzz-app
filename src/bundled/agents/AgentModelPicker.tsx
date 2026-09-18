import { Combobox } from "@base-ui/react/combobox";
import { useEffect, useId, useRef, useState } from "react";
import type {
  AgentControl,
  ControlSnapshot,
} from "../../features/agents/control";
import type { ModelCatalog } from "../../features/agents/models";
import { Button } from "../../shared/design-system/ui/Button";
import { agentEdit, type AgentDraft } from "./agent-edit";

export function AgentModelPicker({
  id,
  draft,
  savedRevision,
  control,
  defaults,
  onChange,
}: {
  id: string;
  savedRevision: number;
  draft: AgentDraft;
  control: AgentControl;
  defaults: ControlSnapshot["databricksDefaults"];
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const searchId = useId();
  const host = draft.databricks?.host ?? defaults?.host ?? "";
  const filter = draft.databricks?.filter ?? defaults?.filter ?? "";
  const [catalog, setCatalog] = useState<{
    key: string;
    data: ModelCatalog;
  } | null>(null);
  const [status, setStatus] = useState(
    "Not connected. Custom model entry is always available.",
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  // All draft context participates: native resolves write-only overrides against
  // the saved revision. No draft value is persisted or sent until an explicit click.
  const key = JSON.stringify([
    id,
    savedRevision,
    draft.revision,
    draft.command,
    draft.provider,
    draft.args,
    draft.environment,
    host,
    filter,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: context change cancels actual native work even when no result has arrived.
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setStatus(
      "No current connection evidence. Connect or refresh explicitly; custom entry remains available.",
    );
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [key]);
  const run = async (action: "connect" | "refresh" | "disconnect") => {
    if (!control.models || busy) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setCatalog(null);
    setStatus(
      action === "connect"
        ? "Connecting… complete sign-in in your browser if asked."
        : action === "refresh"
          ? "Loading models without opening sign-in…"
          : "Removing this app’s credentials for this workspace…",
    );
    try {
      const data = await control.models.request(
        {
          id,
          expectedRevision: draft.revision,
          edit: action === "disconnect" ? undefined : agentEdit(draft),
          host,
          filter,
          action,
        },
        abort.signal,
      );
      if (abort.signal.aborted || currentKey.current !== key) return;
      setCatalog({ key, data });
      setStatus(
        data.disconnected
          ? "Disconnected. This app’s cached credentials for this workspace were removed; provider/browser sessions are not revoked."
          : data.models.length
            ? "Models loaded. Availability may be partial; choose an ID explicitly. This does not enable execution."
            : "No discovered models match. Enter a custom ID or change the filter and refresh.",
      );
    } catch (error) {
      if (!abort.signal.aborted && currentKey.current === key)
        setStatus((error as Error).message);
    } finally {
      if (pending.current === abort) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const fresh = catalog?.key === key ? catalog.data : null;
  return (
    <section
      data-buzz-ui=""
      className="space-y-3 text-body"
      aria-label="Databricks models"
    >
      <label className="agent-control-field">
        Model
        <input
          value={draft.model}
          spellCheck={false}
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </label>
      <p className="text-body-sm text-secondary">
        Blank and unlisted IDs are preserved. Loading or searching never changes
        your model.
      </p>
      <details className="space-y-3">
        <summary className="cursor-pointer text-body-sm">
          Connect and search Databricks v2 models
        </summary>
        <label className="agent-control-field">
          Databricks workspace (HTTPS origin)
          <input
            value={host}
            placeholder="https://workspace.example.com"
            spellCheck={false}
            onChange={(event) =>
              onChange({ databricks: { host: event.target.value, filter } })
            }
          />
        </label>
        <label className="agent-control-field">
          Model filter (optional; comma-separated * and ? patterns)
          <input
            value={filter}
            spellCheck={false}
            onChange={(event) =>
              onChange({ databricks: { host, filter: event.target.value } })
            }
          />
        </label>
        <p className="text-body-sm text-secondary">
          Connect may open your browser. Credentials stay in this app’s private
          native cache, separate from old Buzz. Refresh never opens sign-in.
          Save persists workspace/filter for inference; Connect does not save or
          start an agent. Saved or draft environment overrides must match.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !control.models}
            onClick={() => void run("connect")}
          >
            Connect
          </Button>
          <Button
            disabled={busy || !control.models}
            onClick={() => void run("refresh")}
          >
            Refresh models
          </Button>
          <Button
            disabled={!busy}
            onClick={() => {
              pending.current?.abort();
              pending.current = null;
              setBusy(false);
              setStatus(
                "Connection cancelled. Any completed sign-in may remain cached; Disconnect removes this app’s credentials.",
              );
            }}
          >
            Cancel connection
          </Button>
          <Button
            disabled={busy || !control.models}
            onClick={() => void run("disconnect")}
          >
            Disconnect
          </Button>
        </div>
        <p role="status" className="text-body-sm text-secondary">
          {catalog && !fresh
            ? "Settings changed; previous catalog is stale. Refresh explicitly. "
            : ""}
          {status}
        </p>
        {fresh?.modelOverridden && (
          <p className="text-body-sm text-secondary">
            BUZZ_AGENT_MODEL overrides the Model field. Change/remove that
            environment override explicitly to use your selection.
          </p>
        )}
        {!!fresh?.models.length && (
          <div className="buzz-select">
            <Combobox.Root<ModelCatalog["models"][number]>
              items={fresh.models}
              value={
                fresh.models.find((model) => model.id === draft.model) ?? null
              }
              itemToStringLabel={(model) => `${model.name} — ${model.id}`}
              onValueChange={(model) => {
                if (model) onChange({ model: model.id });
              }}
            >
              <label htmlFor={searchId}>Search available models</label>
              <Combobox.Input
                id={searchId}
                placeholder="Search name or model ID"
                className="agent-model-search"
              />
              <Combobox.Trigger render={<Button>Browse models</Button>}>
                Browse models
              </Combobox.Trigger>
              <Combobox.Portal>
                <Combobox.Positioner sideOffset={4}>
                  <Combobox.Popup
                    data-buzz-ui=""
                    className="buzz-select-popup text-body-sm"
                  >
                    <Combobox.Empty>
                      No matching models. Use custom entry above.
                    </Combobox.Empty>
                    <Combobox.List>
                      {(model: ModelCatalog["models"][number]) => (
                        <Combobox.Item
                          key={model.id}
                          value={model}
                          className="buzz-select-option"
                        >
                          <span>{model.name}</span>
                          <span className="text-secondary">{model.id}</span>
                        </Combobox.Item>
                      )}
                    </Combobox.List>
                  </Combobox.Popup>
                </Combobox.Positioner>
              </Combobox.Portal>
            </Combobox.Root>
          </div>
        )}
      </details>
    </section>
  );
}
