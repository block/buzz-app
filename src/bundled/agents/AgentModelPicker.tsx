import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { useEffect, useRef, useState } from "react";
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
  disabled = false,
}: {
  disabled?: boolean;
  id?: string | undefined;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  defaults: ControlSnapshot["databricksDefaults"];
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const host = draft.databricks?.host ?? defaults?.host ?? "";
  const filter = draft.databricks?.filter ?? defaults?.filter ?? "";
  const [catalog, setCatalog] = useState<{
    key: string;
    data: ModelCatalog;
  } | null>(null);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const attempted = useRef<string | null>(null);
  // Native resolves absolute executables and write-only provider overrides.
  const supported = !!control.models;
  const highlighted = useRef<ModelCatalog["models"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  // All draft context participates: native resolves write-only overrides against
  // the saved revision. Discovery never persists draft values.
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
    setStatus("");
    setQuery(null);
    setOpen(false);
    attempted.current = null;
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [key]);
  const run = async (action: "connect" | "refresh" | "disconnect") => {
    if (!control.models || pending.current) return;
    if (!host.trim()) {
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
        ? "Loading models… sign in through your browser if asked."
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
          ? "Disconnected from this workspace in Foundation."
          : data.models.length
            ? ""
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
  const fresh = catalog?.key === key ? catalog.data : null;
  const entries = fresh?.models ?? [];
  const selected =
    entries.find((model) => model.id === draft.model) ??
    (draft.model ? { id: draft.model, name: draft.model } : null);
  const items = [...entries];
  if (selected && !entries.some((model) => model.id === selected.id))
    items.unshift(selected);
  const custom = query?.trim();
  if (
    custom &&
    !items.some((model) => model.id === custom || model.name === custom)
  )
    items.push({ id: custom, name: custom });
  const commitQuery = () => {
    if (query === null) return;
    const match = entries.find(
      (item) => item.id === query || item.name === query,
    );
    onChange({ model: match?.id ?? query });
    setQuery(null);
  };
  return (
    <section data-buzz-ui="" className="text-body" aria-label="Model settings">
      <div className="space-y-3">
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
              if (model) onChange({ model: model.id });
              setQuery(null);
            }}
          >
            <Combobox.Control
              label="Model"
              triggerLabel="Browse models"
              loading={busy}
              onBrowse={() => {
                if (supported && !fresh && attempted.current !== key)
                  void run("connect");
              }}
              placeholder="Choose or enter a model"
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
            Cancel sign-in
          </Button>
        ) : (
          status &&
          supported && (
            <Button disabled={disabled} onClick={() => void run("connect")}>
              Retry models
            </Button>
          )
        )}
        {fresh?.modelOverridden && (
          <p className="text-body-sm text-warning">
            A saved BUZZ_AGENT_MODEL override takes precedence. Change it in
            Advanced → Environment to use this selection.
          </p>
        )}
      </div>
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
                  {supported && (
                    <>
                      <Field label="Databricks workspace (HTTPS origin)">
                        <Input
                          disabled={disabled}
                          value={host}
                          placeholder="https://workspace.example.com"
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
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({
                              databricks: { host, filter: event.target.value },
                            })
                          }
                        />
                      </Field>
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
                        app’s cache, not your browser session. Save does not
                        restart an agent.
                      </p>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>
    </section>
  );
}
