import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon, TrashIcon } from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";

/** A row being edited. A saved row's value stays native: an empty `value`
 * keeps it, anything typed replaces it. */
type Row = { key: number; name: string; value: string; saved: boolean };
type Status = { names: string[] };

/** Variables one local agent starts with, held natively in the OS credential
 * store. Values are never read back. */
export function AgentEnvironment({
  agent,
  restartAgent,
}: {
  agent: string;
  /** Stops the agent's processes, so its next turn starts with the list. */
  restartAgent: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Row[] | undefined>();
  const [restarting, setRestarting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const restart = useRef<HTMLButtonElement>(null);
  const next = useRef(0);
  // Leaving the agent with unsaved edits, or during a save, asks first.
  useAgentSaveState(dirty, pending);
  const load = useCallback((status: Status) => {
    setRows(
      status.names.map((name) => ({
        key: next.current++,
        name,
        value: "",
        saved: true,
      })),
    );
    setDirty(false);
  }, []);
  const fetch = useCallback(() => {
    setError(undefined);
    // Hosts without the native list (test fixtures) answer nothing.
    invoke<Status | null>("agent_env_status", { agent }).then(
      (status) => status && load(status),
      (reason: unknown) => setError(String(reason)),
    );
  }, [agent, load]);
  useEffect(() => {
    if (isTauri()) fetch();
  }, [fetch]);
  // An unreadable list is never shown as an empty one.
  if (!rows)
    return error ? (
      <div className="mt-section-gap">
        <InlineHeader title="Environment variables" />
        <p role="alert" className="m-0 mb-2 text-body-sm">
          {error}
        </p>
        <Button size="sm" onClick={fetch}>
          Retry
        </Button>
      </div>
    ) : null;
  // Nothing changes the list while a save or a restart runs: a save during
  // a restart could miss the process the restart starts.
  const locked = pending || restarting;
  const edit = (key: number, change: Partial<Row>) => {
    setRows(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
    setDirty(true);
  };
  const save = async () => {
    setPending(true);
    setError(undefined);
    try {
      await invoke("agent_env_set", {
        agent,
        rows: rows.map((row) => ({
          name: row.name.trim(),
          value: row.saved && !row.value ? null : row.value,
        })),
      });
      load(await invoke<Status>("agent_env_status", { agent }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="mt-section-gap">
      <InlineHeader title="Environment variables" />
      <p className="m-0 mb-2 text-body-sm text-subtle">
        Variables this agent starts with.
      </p>
      <SettingsGroup layout="form">
        {rows.map((row) => (
          <div key={row.key} className="flex items-end gap-2">
            <Field label="Variable name">
              <Input
                placeholder="NAME"
                value={row.name}
                disabled={row.saved || locked}
                autoCapitalize="off"
                spellCheck={false}
                onValueChange={(name) => edit(row.key, { name })}
              />
            </Field>
            <Field
              label={
                <>
                  Value
                  <span className="sr-only">
                    {" "}
                    of {row.name || "new variable"}
                  </span>
                </>
              }
            >
              <Input
                type="password"
                placeholder={row.saved ? "Saved — type to replace" : "Value"}
                value={row.value}
                disabled={locked}
                onValueChange={(value) => edit(row.key, { value })}
              />
            </Field>
            <IconButton
              aria-label={`Remove ${row.name || "variable"}`}
              icon={<TrashIcon size={17} />}
              disabled={locked}
              onClick={() => {
                setRows(rows.filter((other) => other.key !== row.key));
                setDirty(true);
              }}
            />
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            disabled={locked}
            onClick={() => {
              setRows([
                ...rows,
                { key: next.current++, name: "", value: "", saved: false },
              ]);
              setDirty(true);
            }}
          >
            <PlusIcon size={17} aria-hidden="true" />
            Add variable
          </Button>
          <Button
            size="sm"
            variant="prominent"
            // Focusable while saving and after, so focus stays on Save.
            disabled={!dirty}
            loading={pending}
            focusableWhenDisabled
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
        {error && (
          <p role="alert" className="m-0 text-body-sm">
            {error}
          </p>
        )}
        <PreferenceRow
          title="Restart agent"
          subtitle={
            dirty
              ? "Save your changes first."
              : "Processes already running keep the variables they started with."
          }
          trailing={
            <Button
              ref={restart}
              size="sm"
              // A restart would race a save, or drop unsaved edits.
              disabled={pending || restarting || dirty}
              loading={restarting}
              focusableWhenDisabled
              onClick={() => setConfirm(true)}
            >
              Restart agent
            </Button>
          }
        />
      </SettingsGroup>
      {confirm && (
        <AlertDialog
          title="Restart this agent?"
          description="Its processes stop, and its next message starts them with the saved environment variables. Other agents keep running."
          finalFocus={restart}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  setConfirm(false);
                  setRestarting(true);
                  setError(undefined);
                  restartAgent()
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      ),
                    )
                    .finally(() => setRestarting(false));
                }}
              >
                Restart
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
