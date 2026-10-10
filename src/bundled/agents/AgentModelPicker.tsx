import { newestModelsFirst } from "./model-order";
import { modelFamily } from "./model-family";
import { ModelProviderIcon } from "./ModelProviderIcon";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import {
  useLayoutEffect,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentControl,
  ControlSnapshot,
  HarnessConfigurationPolicy,
} from "../../features/agents/control";
import type { ModelCatalog, ModelRequest } from "../../features/agents/models";
import {
  CaretRightIcon,
  CaretLeftIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { agentEdit, isGoose, type AgentDraft } from "./agent-edit";

const VISIBLE_MODEL_LIMIT = 10;
type ModelOption = ModelCatalog["models"][number] & {
  action?: "advanced" | "family" | "back";
  family?: string;
};

// Catalog labels win once loaded; trim the known namespace for the cold default.
function modelTitle(id: string) {
  return id
    .replace(/^system\.ai\./, "")
    .replace(/^databricks-/, "")
    .replace(/(\d)-(\d)/g, "$1.$2")
    .split("-")
    .map((word) =>
      /^(gpt|llama|ai)$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

export function AgentModelPicker({
  id,
  draft,
  savedRevision,
  control,
  defaults,
  defaultModel,
  inheritedWorkspace,
  onPiProviders,
  onChange,
  disabled = false,
  policy,
  providerSelection = 0,
  renderSections,
  compact = false,
  feedbackInPopup = false,
  catalogProvider,
  onAdvanced,
  advancedOpen = false,
  integration,
}: {
  compact?: boolean;
  feedbackInPopup?: boolean;
  catalogProvider?: string | undefined;
  onAdvanced?: (() => void) | undefined;
  advancedOpen?: boolean;
  renderSections?(model: ReactNode, advanced: ReactNode): ReactNode;
  /** Incremented by a committed dropdown choice; custom typing never loads. */
  providerSelection?: number;
  policy?: HarnessConfigurationPolicy | undefined;
  integration?: ModelRequest["integration"];
  disabled?: boolean;
  /** Pi's signed-in providers, or null while its catalog is loading. */
  onPiProviders?(providers: string[] | null): void;
  id?: string | undefined;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  defaults: ControlSnapshot["databricksDefaults"];
  defaultModel?: string | undefined;
  /** Workspace/filter supplied by write-only Agent defaults; values stay native. */
  inheritedWorkspace?: { host: boolean; filter: boolean };
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const statusId = useId();
  const [family, setFamily] = useState<string | null>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [textWidth, setTextWidth] = useState(0);
  const goose = isGoose(draft.command);
  const pi = policy
    ? policy.provider === "discovered"
    : draft.command.split("/").at(-1) === "buzz-pi-acp";
  const external = policy
    ? policy.authentication === "harnessWithOverrides"
    : goose || pi;
  // An inherited Agent defaults value wins over the compiled floor at launch;
  // leave it blank here so native resolves the same hidden value.
  const host =
    draft.databricks?.host ??
    (inheritedWorkspace?.host ? "" : (defaults?.host ?? ""));
  const filter =
    draft.databricks?.filter ??
    (inheritedWorkspace?.filter ? "" : (defaults?.filter ?? ""));
  const [catalog, setCatalog] = useState<{
    key: string;
    data: ModelCatalog;
  } | null>(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const attempted = useRef<string | null>(null);
  // The settings form survives while presets temporarily unmount this picker.
  // Treat its current counter as already consumed when mounting so only a new
  // committed provider choice can initiate Goose discovery.
  const consumedProviderSelection = useRef(providerSelection);
  // Native resolves absolute executables and write-only provider overrides.
  const supported = !!control.models;
  const highlighted = useRef<ModelOption | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  // All draft context participates: native resolves write-only overrides against
  // the saved revision. Discovery never persists draft values.
  const key = JSON.stringify([
    id,
    savedRevision,
    draft.revision,
    draft.command,
    pi ? null : draft.provider,
    draft.args,
    draft.workspace,
    draft.environment,
    pi ? null : host,
    pi ? null : filter,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: context change cancels actual native work even when no result has arrived.
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setStatus("");
    setQuery(null);
    setOpen(false);
    setFamily(null);
    attempted.current = null;
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [key]);
  // Provider is only a filter for Pi's catalog, but pending search text belongs
  // to the provider the person was editing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider changes retire its pending search text without invalidating Pi’s catalog.
  useEffect(() => {
    setQuery(null);
    highlighted.current = null;
  }, [draft.provider]);
  // A test result belongs to the exact draft it tested.
  const testKey = JSON.stringify([key, draft.provider, draft.model]);
  const [test, setTest] = useState<{
    key: string;
    run: AbortController;
    result: string;
    model?: string | undefined;
  } | null>(null);
  const testing = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: editing the tested draft retires its native test.
  useEffect(
    () => () => {
      testing.current?.abort();
      testing.current = null;
    },
    [testKey],
  );
  const testResult = test?.key === testKey ? test.result : null;
  let testMessage = testResult;
  if (testResult === "ok") {
    testMessage = test?.model
      ? `Connected using ${test.model}.`
      : "Connected. The model replied.";
  } else if (testResult === "testing") {
    testMessage = "Sending a short test message…";
  }
  const testConnection = async () => {
    if (!control.models || testing.current) return;
    pending.current?.abort();
    pending.current = null;
    // Closing the popup can restore focus and request it again. Only an
    // explicit Browse action should replace this connection test.
    attempted.current = key;
    setBusy(false);
    setStatus("");
    setOpen(false);
    const run = new AbortController();
    testing.current = run;
    // Only this run may settle its own result; a retired run clears it.
    const settle = (result: string, model?: string) =>
      setTest((current) => {
        if (current?.run !== run) return current;
        if (run.signal.aborted) return null;
        return { ...current, result, model };
      });
    setTest({ key: testKey, run, result: "testing" });
    try {
      const result = await control.models.request(
        {
          id,
          expectedRevision: id ? draft.revision : undefined,
          edit: agentEdit(draft, true),
          host: "",
          filter: "",
          action: "test",
          integration,
        },
        run.signal,
      );
      settle("ok", result.testedModel);
    } catch (error) {
      settle((error as Error).message);
    } finally {
      if (testing.current === run) testing.current = null;
    }
  };
  const run = async (action: "connect" | "refresh" | "disconnect") => {
    if (!control.models || pending.current) return;
    // Native runs one lookup at a time; model browsing replaces a test.
    testing.current?.abort();
    testing.current = null;
    setTest(null);
    if (!external && !host.trim() && !inheritedWorkspace?.host) {
      setStatus(
        "Set your Databricks workspace under Advanced → Model to browse models.",
      );
      return;
    }
    attempted.current = key;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setCatalog(null);
    setStatus(
      action === "connect"
        ? external
          ? `Loading ${pi ? "Pi" : "Goose"} models…`
          : "Loading models… sign in through your browser if asked."
        : action === "refresh"
          ? "Loading models…"
          : "Removing this app’s credentials for this workspace…",
    );
    try {
      const data = await control.models.request(
        {
          id,
          expectedRevision: id ? draft.revision : undefined,
          edit: action === "disconnect" ? undefined : agentEdit(draft, true),
          host: external ? "" : host,
          filter: external ? "" : filter,
          action,
          integration,
          selectedModel: draft.model || undefined,
          ...(!external &&
          ((inheritedWorkspace?.host && !host) ||
            (inheritedWorkspace?.filter && !filter))
            ? { inheritWorkspace: true }
            : {}),
        },
        abort.signal,
      );
      if (abort.signal.aborted || currentKey.current !== key) return;
      setCatalog({ key, data });
      setStatus(
        data.disconnected
          ? "Disconnected from this workspace in Foundation."
          : data.models.length
            ? ""
            : goose
              ? "No models found for this Goose provider. Check its configuration or enter a custom ID."
              : pi
                ? "No signed-in Pi providers found. Buzz doesn’t use API keys exported in your shell profile. Choose a provider under LLM Provider to add its API key, or enter a custom ID."
                : "No models found. Enter a custom ID or check the workspace/filter under Advanced → Model.",
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
  // Pi's catalog is headless and supplies the signed-in provider list, so load
  // it when Pi is selected. Later context edits wait for Browse or Retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only entering Pi triggers the automatic lookup.
  useEffect(() => {
    if (pi) void run("connect");
  }, [pi, draft.command]);
  // Provider selection loads Goose's catalog. Credential/context edits retire
  // that request but wait for Browse or Retry, never signing in per keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only selecting a Goose provider triggers automatic discovery.
  useEffect(() => {
    if (providerSelection === consumedProviderSelection.current) return;
    consumedProviderSelection.current = providerSelection;
    if (providerSelection && goose && draft.provider) void run("connect");
  }, [providerSelection]);
  const fresh = catalog?.key === key ? catalog.data : null;
  const reportedProviders = JSON.stringify(
    !pi
      ? []
      : busy
        ? null
        : [...new Set(fresh?.models.map((m) => m.id.split("/")[0] ?? ""))],
  );
  useEffect(() => {
    onPiProviders?.(JSON.parse(reportedProviders));
  }, [reportedProviders, onPiProviders]);
  useEffect(() => () => onPiProviders?.([]), [onPiProviders]);
  const entries = (fresh?.models ?? []).filter(
    (m) => !pi || !draft.provider || m.id.startsWith(`${draft.provider}/`),
  );
  const piNoModelsMessage =
    "No Pi models for this provider. Buzz doesn’t use API keys exported in your shell profile. Add this provider’s API key for this agent, then browse models again.";
  const effectiveModel = draft.model || (compact ? (defaultModel ?? "") : "");
  const selectedId =
    pi && draft.provider && draft.model
      ? `${draft.provider}/${draft.model}`
      : effectiveModel;
  const chooseModel = (value: string) => {
    if (compact && defaultModel && value === defaultModel) {
      onChange({ model: "" });
      return;
    }
    if (pi && value.includes("/") && entries.some((m) => m.id === value)) {
      const split = value.indexOf("/");
      onChange({
        provider: value.slice(0, split),
        model: value.slice(split + 1),
      });
    } else {
      const prefix = `${draft.provider}/`;
      onChange({
        model:
          pi && draft.provider && value.startsWith(prefix)
            ? value.slice(prefix.length)
            : value,
      });
    }
  };
  const selected =
    entries.find((model) => model.id === selectedId) ??
    (effectiveModel
      ? {
          id: effectiveModel,
          name: compact ? modelTitle(effectiveModel) : effectiveModel,
        }
      : null);
  const items: ModelOption[] = newestModelsFirst(entries);
  if (
    compact &&
    defaultModel &&
    !items.some((item) => item.id === defaultModel)
  )
    items.unshift({ id: defaultModel, name: modelTitle(defaultModel) });
  if (selected && !items.some((model) => model.id === selected.id))
    items.unshift(selected);
  const custom = query?.trim();
  if (
    custom &&
    !items.some((model) => model.id === custom || model.name === custom)
  )
    items.push({ id: custom, name: custom });
  const matchingModels =
    query === null
      ? items
      : items.filter((item) =>
          `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase()),
        );
  const advancedOption: ModelOption = {
    id: "",
    name: advancedOpen ? "Back to agent setup" : "Configure AI setup",
    action: "advanced",
  };
  const familyOrder = [
    "OpenAI",
    "Claude",
    "Gemini",
    "Grok",
    "DeepSeek",
    "Kimi",
    "LLaMA",
    "Qwen",
    "Mistral",
    "Other models",
  ];
  const families = [...new Set(entries.map(modelFamily))].sort(
    (a, b) => familyOrder.indexOf(a) - familyOrder.indexOf(b),
  );
  const grouped =
    !external &&
    /databricks/.test(catalogProvider ?? draft.provider) &&
    families.length > 1;
  // Search crosses families; browsing drills into one family without committing it.
  const browsingFamilies = grouped && !query?.trim();
  const familyOptions: ModelOption[] = families.map((name) => ({
    id: name,
    name,
    action: "family",
    family: name,
  }));
  const backOption: ModelOption = {
    id: "",
    name: "All model families",
    action: "back",
  };
  const visibleModels =
    goose && busy
      ? []
      : goose
        ? matchingModels.slice(0, VISIBLE_MODEL_LIMIT)
        : matchingModels;
  const matchingItems: ModelOption[] = browsingFamilies
    ? family
      ? [
          backOption,
          ...visibleModels.filter((model) => modelFamily(model) === family),
        ]
      : [...(onAdvanced ? [advancedOption] : []), ...familyOptions]
    : [...(onAdvanced ? [advancedOption] : []), ...visibleModels];
  const inputText = query ?? selected?.name ?? "";
  useLayoutEffect(() => {
    if (!compact || !measure.current) return;
    const update = () =>
      setTextWidth(measure.current?.getBoundingClientRect().width ?? 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(measure.current);
    return () => observer.disconnect();
  }, [compact]);
  const commitQuery = () => {
    if (query === null) return;
    const match = entries.find(
      (item) => item.id === query || item.name === query,
    );
    chooseModel(match?.id ?? query);
    setQuery(null);
  };
  const modelFeedback = (
    <>
      {goose && fresh && entries.length > VISIBLE_MODEL_LIMIT && (
        <p className="text-body-sm text-secondary">
          Showing up to {VISIBLE_MODEL_LIMIT} models. Type to search all{" "}
          {entries.length}.
        </p>
      )}
      {!compact && status && (!open || busy) && (
        <p
          id={statusId}
          role="status"
          className={`text-body-sm ${busy && goose ? "flex items-center gap-2 text-primary" : "text-secondary"}`}
        >
          {busy && goose && (
            <CircleNotchIcon
              size={16}
              className="motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
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
          {external ? "Cancel model lookup" : "Cancel sign-in"}
        </Button>
      ) : (
        status &&
        supported && (
          <Button disabled={disabled} onClick={() => void run("connect")}>
            Retry models
          </Button>
        )
      )}
      {(policy ? policy.model === "withProvider" : pi) &&
        draft.provider &&
        !draft.model && (
          <p className="text-body-sm text-warning">
            Choose a model for this provider before starting, or clear Provider
            to use Pi defaults.
          </p>
        )}
      {pi && fresh && entries.length === 0 && draft.provider && (
        <p className="text-body-sm text-secondary">{piNoModelsMessage}</p>
      )}
      {pi &&
        fresh &&
        draft.model &&
        !entries.some((model) => model.id === selectedId) && (
          <p className="text-body-sm text-warning">
            This model ID is not in Pi’s available catalog. Select a listed
            model or confirm the exact custom ID before starting; Pi may accept
            an invalid ID until the first message.
          </p>
        )}
      {fresh?.modelOverridden && (
        <p className="text-body-sm text-warning">
          {goose ? "A GOOSE_MODEL" : "A saved BUZZ_AGENT_MODEL"} environment
          override takes precedence. Change it in Advanced → Environment to use
          this selection.
        </p>
      )}
      {goose &&
        fresh &&
        draft.model &&
        !entries.some((model) => model.id === draft.model) && (
          <p className="text-body-sm text-warning">
            This model ID is not in Goose’s current provider list. Select a
            listed model or confirm the custom ID before starting.
          </p>
        )}
      {goose && (
        <p className="text-body-sm text-secondary">
          Models load for the selected provider using credentials entered above
          or already configured in Goose. You can also enter a custom model ID.
        </p>
      )}
    </>
  );
  const modelFields = (
    <div
      className={compact ? "agent-compact-model-fields space-y-3" : "space-y-3"}
    >
      {supported && external && draft.provider && (
        <div className="space-y-2">
          <Button
            disabled={disabled}
            loading={testResult === "testing"}
            onClick={() => void testConnection()}
          >
            Test connection
          </Button>
          {testResult && (
            <p
              role="status"
              className={`flex items-center gap-2 text-body-sm ${testResult === "ok" ? "text-success" : testResult === "testing" ? "text-secondary" : "text-danger"}`}
            >
              {testResult === "ok" ? (
                <CheckCircleIcon size={16} aria-hidden="true" />
              ) : testResult !== "testing" ? (
                <WarningCircleIcon size={16} aria-hidden="true" />
              ) : null}
              {testMessage}
            </p>
          )}
        </div>
      )}
      <div>
        {compact && (
          <span
            ref={measure}
            aria-hidden="true"
            className="agent-model-measure"
          >
            {inputText || "Choose a model"}
          </span>
        )}
        <Combobox.Root<ModelOption>
          disabled={disabled}
          items={busy ? [] : matchingItems}
          filteredItems={busy ? [] : matchingItems}
          value={selected}
          inputValue={inputText}
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
            if (!next) setFamily(null);
            if (
              next &&
              details.reason !== "input-change" &&
              supported &&
              !fresh &&
              attempted.current !== key
            )
              void run("connect");
            if (!next && details.reason === "escape-key") setQuery(null);
          }}
          modal={false}
          onItemHighlighted={(item) => {
            highlighted.current = item ?? null;
          }}
          itemToStringLabel={(model) => model.name}
          isItemEqualToValue={(a, b) => a.id === b.id && a.action === b.action}
          onValueChange={(model, details) => {
            if (model?.action === "family" || model?.action === "back") {
              details.cancel();
              setFamily(
                model.action === "back" ? null : (model.family ?? null),
              );
              setQuery(null);
              setOpen(true);
              return;
            }
            if (model?.action === "advanced") {
              onAdvanced?.();
              setOpen(false);
            } else if (model) chooseModel(model.id);
            setQuery(null);
          }}
        >
          <Combobox.Control
            label="Model"
            style={
              compact
                ? {
                    width: textWidth ? `${Math.ceil(textWidth) + 2}px` : "12ch",
                    flex: "0 1 auto",
                  }
                : undefined
            }
            labelVisibility={compact ? "hidden" : "visible"}
            triggerLabel="Browse models"
            leading={
              <ModelProviderIcon
                model={
                  selected
                    ? `${selected.id} ${selected.name}`
                    : (defaultModel ?? "")
                }
                provider={draft.provider}
              />
            }
            aria-describedby={!compact && status ? statusId : undefined}
            loading={busy}
            onBrowse={() => {
              if (
                supported &&
                !fresh &&
                (attempted.current !== key || testResult !== null)
              )
                void run("connect");
            }}
            placeholder={
              defaultModel && !compact
                ? `Use agent defaults (${defaultModel})`
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
            className={`agent-model-options${grouped ? " agent-family-popup" : goose ? " agent-model-popup" : ""}`}
            empty={
              busy || status ? null : "Type a model ID to use a custom model."
            }
          >
            {busy && (
              <div
                role="status"
                aria-label="Model lookup"
                className="agent-model-loading"
              >
                <span className="sr-only">
                  {pi ? "Loading Pi models…" : "Loading models…"}
                </span>
                {[72, 88, 60, 78].map((width) => (
                  <div
                    key={width}
                    className="agent-model-loading-row"
                    aria-hidden="true"
                  >
                    <span className="agent-model-loading-icon" />
                    <span
                      className="agent-model-loading-label"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                ))}
              </div>
            )}
            {!compact &&
              !busy &&
              (status ||
                (pi && fresh && draft.provider && entries.length === 0)) && (
                <div
                  id={!busy ? statusId : undefined}
                  className="px-3 py-2 text-body-sm text-secondary"
                >
                  {pi && fresh && draft.provider && entries.length === 0
                    ? piNoModelsMessage
                    : status}
                </div>
              )}
            {!busy && (
              <Combobox.List
                style={{
                  maxHeight: "min(20rem, calc(var(--available-height) - 4rem))",
                  overflowY: "auto",
                }}
              >
                {(model: ModelOption) => {
                  if (model.action === "family" || model.action === "back")
                    return (
                      <Combobox.Item
                        key={`${model.action}-${model.id}`}
                        value={model}
                      >
                        <span className="agent-model-family-row flex items-center gap-2">
                          {model.action === "family" && (
                            <ModelProviderIcon model={model.name} provider="" />
                          )}
                          {model.action === "back" && (
                            <CaretLeftIcon size={16} aria-hidden="true" />
                          )}
                          <span className="flex-1">{model.name}</span>
                          {model.action === "family" && (
                            <CaretRightIcon size={16} aria-hidden="true" />
                          )}
                        </span>
                      </Combobox.Item>
                    );
                  if (model.action === "advanced")
                    return (
                      <Combobox.Item key="advanced" value={model}>
                        {model.name}
                      </Combobox.Item>
                    );
                  const custom = !entries.some(
                    (entry) => entry.id === model.id,
                  );
                  return (
                    <Combobox.Item
                      key={model.id}
                      value={model}
                      description={
                        !external
                          ? undefined
                          : goose && model.name === model.id
                            ? custom
                              ? "Custom ID"
                              : undefined
                            : `${model.id}${custom ? " · Custom ID" : ""}`
                      }
                    >
                      <span className="flex items-center gap-2">
                        <ModelProviderIcon
                          model={`${model.id} ${model.name}`}
                          provider={draft.provider}
                        />
                        {model.name}
                      </span>
                    </Combobox.Item>
                  );
                }}
              </Combobox.List>
            )}
            {feedbackInPopup && modelFeedback}
          </Combobox.Popup>
        </Combobox.Root>
      </div>
      {!feedbackInPopup && modelFeedback}
    </div>
  );
  const advancedFields = (
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
                  {pi && (
                    <p className="text-body-sm text-secondary">
                      This field uses the exact model ID, including any
                      namespace slashes, without adding the provider. Its text
                      is saved literally.
                    </p>
                  )}
                  {supported && pi && (
                    <Button
                      disabled={disabled || busy}
                      onClick={() => void run("refresh")}
                    >
                      Refresh models
                    </Button>
                  )}
                  {supported && !external && (
                    <>
                      <Field label="Databricks workspace (HTTPS origin)">
                        <Input
                          disabled={disabled}
                          value={host}
                          placeholder={
                            inheritedWorkspace?.host
                              ? "Use agent defaults"
                              : "https://workspace.example.com"
                          }
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({
                              databricks: { host: event.target.value, filter },
                            })
                          }
                        />
                      </Field>
                      <Field label="Model filter (optional)">
                        <Input
                          disabled={disabled}
                          value={filter}
                          placeholder={
                            inheritedWorkspace?.filter
                              ? "Use agent defaults"
                              : undefined
                          }
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({
                              databricks: { host, filter: event.target.value },
                            })
                          }
                        />
                      </Field>
                      <p className="text-body-sm text-secondary">
                        Editing either field saves both displayed values.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={disabled || busy}
                          onClick={() => void run("refresh")}
                        >
                          Refresh models
                        </Button>
                        <Button
                          disabled={disabled || busy}
                          onClick={() => void run("disconnect")}
                        >
                          Disconnect
                        </Button>
                      </div>
                      <p className="text-body-sm text-secondary">
                        Credentials are shared within Foundation for this
                        workspace, not with old Buzz. Disconnect removes this
                        app’s cache, not your browser session.
                      </p>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
    </>
  );
  return renderSections ? (
    renderSections(modelFields, advancedFields)
  ) : (
    <section data-buzz-ui="" className="text-body" aria-label="Model settings">
      {modelFields}
      {advancedFields}
    </section>
  );
}
