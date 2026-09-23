import { DatabricksModelSettings } from "./DatabricksModelSettings";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  ControlSnapshot,
} from "../../features/agents/control";
import {
  isVerifiedCatalog,
  ModelError,
  type ModelCatalog,
  type ModelRequest,
} from "../../features/agents/models";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";
import { agentEdit, type AgentDraft } from "./agent-edit";

export function AgentModelPicker({
  id,
  draft,
  savedRevision,
  control,
  defaults,
  capabilities,
  recoveryAvailable = false,
  onChange,
  onValidated,
  validationVersion,
  disabled = false,
}: {
  disabled?: boolean;
  recoveryAvailable?: boolean;
  id?: string | undefined;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  defaults: ControlSnapshot["databricksDefaults"];
  capabilities?: NonNullable<
    ControlSnapshot["harnessOptions"]
  >[number]["capabilities"];
  onChange(patch: Partial<AgentDraft>): void;
  onValidated?: ((draft: AgentDraft | null) => void) | undefined;
  validationVersion?: number | undefined;
}) {
  const host = draft.databricks?.host ?? defaults?.host ?? "";
  const filter = draft.databricks?.filter ?? defaults?.filter ?? "";
  const [catalog, setCatalog] = useState<{
    key: string;
    data: ModelCatalog;
  } | null>(null);
  const [status, setStatus] = useState("");
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const advanced = draft.configuration?.mode === "advanced";
  const defaultsMode = draft.configuration?.mode === "default";
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const attempted = useRef<string | null>(null);
  // Native resolves absolute executables and write-only provider overrides.
  const codex = capabilities?.modelDiscovery === "codex";
  const supported =
    !!control.models &&
    (codex || capabilities?.modelDiscovery === "databricks");
  const highlighted = useRef<ModelCatalog["models"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  // All draft context participates: native resolves write-only overrides against
  // the saved revision. Discovery never persists draft values.
  const key = JSON.stringify([
    validationVersion,
    id,
    savedRevision,
    draft.revision,
    draft.command,
    draft.provider,
    draft.args,
    draft.workspace,
    codex ? null : draft.configuration?.mode,
    draft.environment,
    supported,
    recoveryAvailable,
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
    setCatalog(null);
    setStatus("");
    setAuthenticationRequired(false);
    setQuery(null);
    setOpen(false);
    attempted.current = null;
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [key]);
  const run = async (
    action: "connect" | "refresh" | "disconnect",
    useCache = false,
  ) => {
    if (!control.models || pending.current) return;
    if (action !== "disconnect" && !supported) return;
    if (!codex && !host.trim()) {
      setStatus(
        "Set your Databricks workspace under Advanced → Model to browse models.",
      );
      return;
    }
    attempted.current = key;
    let request: ModelRequest;
    try {
      request = {
        id,
        expectedRevision: id ? draft.revision : undefined,
        edit: action === "disconnect" ? undefined : agentEdit(draft, true),
        integration: codex
          ? { kind: "codex" }
          : { kind: "databricks", settings: { host, filter } },
        action,
      };
    } catch (error) {
      setStatus((error as Error).message);
      return;
    }
    if (codex && useCache) {
      const cached = control.models.cached?.(request);
      if (cached) {
        setCatalog({ key, data: cached });
        setStatus("");
        return;
      }
    }
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setCatalog((previous) =>
      codex && previous
        ? {
            ...previous,
            data: {
              ...previous.data,
              discovery: previous.data.discovery
                ? {
                    ...previous.data.discovery,
                    catalog: "cached",
                  }
                : null,
            },
          }
        : null,
    );
    setAuthenticationRequired(false);
    setStatus(
      action === "connect"
        ? "Loading models… sign in through your browser if asked."
        : action === "refresh"
          ? "Loading models…"
          : "Removing this app’s credentials for this workspace…",
    );
    try {
      if (codex) {
        const cached = control.models.cached?.(request);
        if (cached) setCatalog({ key, data: cached });
      }
      const data = await control.models.request(request, abort.signal);
      if (abort.signal.aborted || currentKey.current !== key) return;
      setCatalog({ key, data });
      setStatus(
        data.disconnected
          ? "Disconnected from this workspace in Foundation."
          : data.models.length
            ? ""
            : advanced
              ? "No available models found. Check your account, workspace and filter, then refresh."
              : "No models found. Enter a custom ID or check the workspace/filter under Advanced → Model.",
      );
    } catch (error) {
      if (!abort.signal.aborted && currentKey.current === key) {
        setStatus((error as Error).message);
        setAuthenticationRequired(
          error instanceof ModelError && error.code === "authentication",
        );
      }
    } finally {
      if (pending.current === abort) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  // Selecting Codex starts a headless refresh; defer one microtask so StrictMode's
  // retired effect cannot start a second native probe. Context cleanup aborts it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key captures the discovery context; draft labels/effort must not restart discovery.
  useEffect(() => {
    let retired = false;
    if (codex && supported)
      void Promise.resolve().then(() => {
        if (!retired) void run("refresh", !validationVersion);
      });
    return () => {
      retired = true;
    };
  }, [key, control.models]);
  const fresh = catalog?.key === key ? catalog.data : null;
  const verified = isVerifiedCatalog(fresh);
  // Older saved drafts may contain model[effort]. Show their advertised base
  // model without silently rewriting the saved configuration on discovery.
  const baseId = draft.model.replace(/\[[^\]]+\]$/, "");
  const selectedId =
    codex && fresh?.models.some((model) => model.id === baseId)
      ? baseId
      : draft.model;
  const discoveredModel = fresh?.models.find(
    (model) => model.id === selectedId,
  );
  const effort =
    draft.configuration?.mode === "advanced"
      ? draft.configuration.effort
      : undefined;
  const effortOptions = discoveredModel?.effort;
  const effortValid =
    effortOptions?.status === "unsupported"
      ? effort?.kind === "unsupported"
      : effortOptions?.status === "supported" &&
        effort?.kind === "value" &&
        effortOptions.options.some((option) => option.value === effort.value);
  const valid =
    !busy &&
    !status &&
    query === null &&
    verified &&
    !!discoveredModel &&
    !discoveredModel.error &&
    effortValid;
  useEffect(() => {
    onValidated?.(valid ? draft : null);
  }, [draft, valid, onValidated]);
  const entries = codex || !advanced || verified ? (fresh?.models ?? []) : [];
  const selected =
    entries.find((model) => model.id === selectedId) ??
    (draft.model ? { id: draft.model, name: draft.model } : null);
  const items = [...entries];
  if (
    !advanced &&
    selected &&
    !entries.some((model) => model.id === selected.id)
  )
    items.unshift(selected);
  const custom = query?.trim();
  if (
    !advanced &&
    custom &&
    !items.some((model) => model.id === custom || model.name === custom)
  )
    items.push({ id: custom, name: custom });
  const chooseModel = (model: string) => {
    onChange({
      model,
      ...(advanced && model !== draft.model
        ? {
            configuration: {
              mode: "advanced" as const,
              effort: { kind: "unsupported" as const },
            },
          }
        : {}),
    });
  };
  const commitQuery = () => {
    if (query === null) return;
    const matches = entries.filter(
      (item) => item.id === query || item.name === query,
    );
    const match =
      entries.find((item) => item.id === query) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (match || !advanced) chooseModel(match?.id ?? query);
    setQuery(null);
  };
  return (
    <section data-buzz-ui="" className="text-body" aria-label="Model settings">
      <div className="space-y-3">
        {codex && defaultsMode && (
          <p role="status" className="text-body-sm text-secondary">
            Default model:{" "}
            {fresh?.defaults?.model ??
              (busy ? "Loading…" : "Not reported by Codex")}
            {" · "}Effort:{" "}
            {fresh?.defaults?.effort ??
              (busy ? "Loading…" : "Not reported by Codex")}
            {fresh?.discovery?.catalog === "cached" &&
              (busy ? " (cached; refreshing)" : " (cached)")}
          </p>
        )}
        {codex && (
          <p className="text-body-sm text-secondary">
            Uses your existing Codex account and configuration. To sign in, run{" "}
            <code>codex login</code> with the same CODEX_HOME/environment, then
            refresh. Choices are reported by Codex and may be cached; they do
            not guarantee inference access or quota.
          </p>
        )}
        {!codex &&
          (defaultsMode || authenticationRequired) &&
          supported &&
          !busy && (
            <Button disabled={disabled} onClick={() => void run("connect")}>
              Connect account
            </Button>
          )}
        {!defaultsMode && (
          <div>
            <Combobox.Root<ModelCatalog["models"][number]>
              disabled={disabled}
              items={items}
              filteredItems={
                query === null
                  ? items
                  : items.filter((item) =>
                      `${item.name} ${item.id}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
              }
              value={selected}
              inputValue={query ?? selected?.name ?? ""}
              open={open}
              onInputValueChange={(value, details) => {
                if (
                  details.reason === "input-change" ||
                  details.reason === "input-clear"
                ) {
                  setQuery(value);
                  // Pending text is an unsaved edit too: enable Save and protect the
                  // dialog while blur/Enter commits it or Escape abandons the query.
                  onChange({});
                }
              }}
              onOpenChange={(next, details) => {
                // Browse opens the list, even if typing already opened it. Base UI
                // may deliver its mousedown toggle after the button's click handler.
                if (!next && details.reason === "trigger-press") {
                  details.cancel();
                  return;
                }
                setOpen(next);
                if (!next && details.reason === "escape-key") setQuery(null);
              }}
              modal={false}
              onItemHighlighted={(item) => {
                highlighted.current = item ?? null;
              }}
              itemToStringLabel={(model) => model.name}
              isItemEqualToValue={(a, b) => a.id === b.id}
              onValueChange={(model) => {
                if (
                  model &&
                  (!advanced || entries.some((entry) => entry.id === model.id))
                )
                  chooseModel(model.id);
                setQuery(null);
              }}
            >
              <Combobox.Control
                label="Model"
                triggerLabel="Browse models"
                loading={busy}
                onBrowse={() => {
                  if (supported && !fresh && attempted.current !== key)
                    void run(advanced || codex ? "refresh" : "connect");
                }}
                placeholder={
                  advanced
                    ? "Choose an available model"
                    : "Choose or enter a model"
                }
                onBlur={commitQuery}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery(null);
                  if (
                    event.key === "Enter" &&
                    !highlighted.current &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    commitQuery();
                    setOpen(false);
                  }
                }}
              />
              <Combobox.Popup
                empty={
                  busy
                    ? "Loading models…"
                    : advanced
                      ? "No matching available models. Refresh the model list."
                      : "Type a model ID to use a custom model."
                }
              >
                <Combobox.List>
                  {(model: ModelCatalog["models"][number]) => (
                    <Combobox.Item
                      key={model.id}
                      value={model}
                      description={`${model.id}${!entries.some((entry) => entry.id === model.id) ? " · Custom ID" : ""}`}
                    >
                      {model.name}
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Root>
          </div>
        )}
        {advanced && (
          <p role="status" className="text-body-sm text-secondary">
            {!fresh
              ? codex
                ? "Loading model and effort choices. Refresh models if discovery fails."
                : "Browse models to verify your account and choices before creating this agent."
              : !verified
                ? "Model discovery is unverified. Refresh models to load choices from this harness."
                : !discoveredModel
                  ? draft.model
                    ? "The selected model is no longer available. Choose an available model; your previous selection is retained."
                    : "Select an available model ID from this account’s catalog."
                  : discoveredModel.error
                    ? discoveredModel.error
                    : effortOptions?.status === "unsupported" && effortValid
                      ? "Effort: Not supported by this integration."
                      : effortValid
                        ? "Model and effort are advertised in the refreshed catalog."
                        : "Choose an available effort for this model. If choices are missing, refresh models."}
          </p>
        )}
        {advanced && verified && effortOptions?.status === "supported" && (
          <>
            <Select
              label="Effort"
              variant="field"
              disabled={disabled || busy}
              value={
                effortValid && effort?.kind === "value" ? effort.value : ""
              }
              groups={[
                {
                  label: "",
                  options: effortOptions.options.map((option) => ({
                    value: option.value,
                    label: option.name,
                  })),
                },
              ]}
              onValueChange={(value) => {
                if (
                  effortOptions.options.some((option) => option.value === value)
                )
                  onChange({
                    ...(codex ? { model: selectedId } : {}),
                    configuration: {
                      mode: "advanced",
                      effort: { kind: "value", value },
                    },
                  });
              }}
            />
            {!effortValid && effort?.kind === "value" && (
              <p className="text-body-sm text-secondary">
                Previous effort: {effort.value}. It is unavailable for this
                model.
              </p>
            )}
          </>
        )}
        {!supported && !defaultsMode && (
          <p className="text-body-sm text-secondary">
            Model browsing is unavailable for this harness or desktop version.
            {advanced
              ? "Advanced creation requires verified model discovery."
              : "You can still enter a custom model ID."}
          </p>
        )}
        {status && (
          <p role="status" className="text-body-sm text-secondary">
            {status}
          </p>
        )}
        {busy ? (
          <Button
            disabled={disabled}
            onClick={() => {
              pending.current?.abort();
              pending.current = null;
              setBusy(false);
              setStatus("Cancelled. Retry when ready.");
            }}
          >
            Cancel model request
          </Button>
        ) : (
          status &&
          supported &&
          !authenticationRequired && (
            <Button
              disabled={disabled}
              onClick={() =>
                void run(advanced || codex ? "refresh" : "connect")
              }
            >
              Retry models
            </Button>
          )
        )}
        {supported && (
          <Button
            disabled={disabled || busy}
            onClick={() => void run("refresh")}
          >
            Refresh models
          </Button>
        )}
        {fresh?.modelOverridden && (
          <p className="text-body-sm text-warning">
            A saved BUZZ_AGENT_MODEL override takes precedence. Change it in
            Advanced → Environment to use this selection.
          </p>
        )}
      </div>
      {!codex && (
        <>
          <h3 className="mt-section-gap mb-2 text-label">Advanced</h3>
          <div className="-mx-2">
            <Accordion
              variant="form"
              keepMounted
              items={[
                {
                  value: "advanced",
                  title: "Model",
                  content: (
                    <div className="space-y-3">
                      {!defaultsMode && !advanced && (
                        <Field label="Model ID (custom or blank)">
                          <Input
                            disabled={disabled}
                            value={draft.model}
                            spellCheck={false}
                            onChange={(event) =>
                              onChange({ model: event.target.value })
                            }
                          />
                        </Field>
                      )}
                      {(supported || recoveryAvailable) && (
                        <DatabricksModelSettings
                          host={host}
                          filter={filter}
                          disabled={disabled}
                          busy={busy}
                          onChange={onChange}
                          run={run}
                        />
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}
    </section>
  );
}
