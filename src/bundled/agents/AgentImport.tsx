import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  AgentImportPreview,
  AgentView,
  ImportSource,
  CloneSettings,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";

export function AgentImport({
  control,
  disabled,
  initialDestination = "",
  managedAgents,
  commitAvailable = true,
  onImported,
  onClone,
}: {
  control: AgentControl;
  disabled: boolean;
  initialDestination?: string;
  managedAgents: readonly AgentView[];
  commitAvailable?: boolean;
  onClone?: ((settings: CloneSettings) => void) | undefined;
  onImported?: (agents: AgentView[]) => void;
}) {
  const [source, setSource] = useState<ImportSource>("installed");
  const [destination, setDestination] = useState(initialDestination);
  const [previewing, setPreviewing] = useState(false);
  const generation = useRef(0);
  const [preview, setPreview] = useState<AgentImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidatePreview = () => {
    generation.current++;
    setPreview(null);
    setPreviewing(false);
    setError(null);
  };
  const load = useCallback(
    async (from: ImportSource, to: string) => {
      const current = ++generation.current;
      setPreview(null);
      setError(null);
      setPreviewing(true);
      try {
        // A failed Start must not force a separate recovery ritual before browsing.
        // Refresh only reads status; it never retries the failed operation.
        await control.refresh();
        if (generation.current !== current) return;
        const result = await control.previewImport(from, to);
        if (generation.current === current) setPreview(result);
      } catch {
        if (generation.current === current)
          setError(
            "Could not load agents from old Buzz. Check Import options and try again.",
          );
      } finally {
        if (generation.current === current) setPreviewing(false);
      }
    },
    [control],
  );
  useEffect(() => {
    void load("installed", initialDestination);
    return () => {
      generation.current++;
    };
  }, [initialDestination, load]);
  const candidates = preview?.candidates.filter(
    (candidate) => !managedAgents.some((agent) => agent.id === candidate.id),
  );
  return (
    <section
      aria-label="Import from old Buzz"
      className="flex flex-col gap-4 pt-3"
    >
      <p className="m-0 text-body-sm text-secondary">
        These agents are not imported into this app. Import keeps the same
        identity and leaves the agent stopped.
      </p>
      {destination && (
        <p className="m-0 break-all text-body-sm">Community: {destination}</p>
      )}
      {!destination && (
        <p className="m-0 text-body-sm text-secondary">
          These identities are saved on this computer. Choose a destination in
          Import options before importing; browsing does not need a connection.
        </p>
      )}
      {!commitAvailable && (
        <p role="status">Import is unavailable in this app session.</p>
      )}
      {previewing && <p role="status">Loading agents from old Buzz…</p>}
      {error && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">{error}</p>
          <Button
            disabled={disabled}
            onClick={() => void load(source, destination)}
          >
            Retry
          </Button>
        </div>
      )}
      {candidates?.length === 0 && (
        <p>
          {destination
            ? "No agents left to import from this library for this community."
            : "No agents in this local library."}
        </p>
      )}
      {candidates?.map((candidate) => (
        <div
          key={candidate.id}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-primary pt-3"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="m-0 font-semibold">{candidate.name}</p>
            <p className="m-0 text-body-sm text-secondary">Not imported</p>
            <details className="text-body-sm text-secondary">
              <summary className="cursor-pointer">Identity</summary>
              <p className="break-all font-mono text-mono-sm">
                {candidate.pubkey}
              </p>
            </details>
          </div>
          {onClone && control.cloneSettings && (
            <Button
              disabled={disabled || previewing}
              aria-label={`Clone ${candidate.name}`}
              onClick={() => {
                const current = generation.current;
                void control
                  .cloneSettings?.(source, candidate.pubkey)
                  .then((settings) => {
                    if (generation.current === current) onClone(settings);
                  })
                  .catch(() => {
                    if (generation.current === current)
                      setError(
                        "Could not read clone settings. Reload the source and try again.",
                      );
                  });
              }}
            >
              Clone to this community
            </Button>
          )}
          <Button
            disabled={
              disabled || previewing || !commitAvailable || !preview?.token
            }
            aria-label={`Import ${candidate.name}`}
            onClick={() => {
              if (!preview?.token) return;
              const current = generation.current;
              void control
                .commitImport(preview.token, [candidate.id])
                .then((result) => {
                  if (generation.current !== current) return;
                  onImported?.(
                    result.agents.filter((agent) => agent.id === candidate.id),
                  );
                })
                .catch(() => {
                  if (generation.current !== current) return;
                  setPreview(null);
                  setError(
                    "Import did not complete. Reload the list before trying again.",
                  );
                });
            }}
          >
            Import
          </Button>
        </div>
      ))}
      <details open={!initialDestination || undefined} className="text-body-sm">
        <summary className="cursor-pointer text-secondary">
          Import options
        </summary>
        <fieldset
          disabled={disabled && !previewing}
          className="flex flex-col gap-3 pt-3"
        >
          <label className="agent-control-field">
            Source library
            <select
              value={source}
              onChange={(event) => {
                const next = event.target.value as ImportSource;
                setSource(next);
                invalidatePreview();
                if (!disabled) void load(next, destination);
              }}
            >
              <option value="installed">Installed Buzz</option>
              <option value="development">Development Buzz</option>
            </select>
          </label>
          <label className="agent-control-field">
            Destination community
            <input
              value={destination}
              placeholder="https://community.example"
              spellCheck={false}
              onChange={(event) => {
                setDestination(event.target.value);
                invalidatePreview();
              }}
            />
          </label>
          <Button
            disabled={disabled || previewing}
            onClick={() => void load(source, destination)}
          >
            Load agents
          </Button>
        </fieldset>
        {preview && (
          <div className="flex flex-col gap-2 pt-3 text-secondary">
            <p className="break-all">{preview.sourcePath}</p>
            {[...new Set(preview.warnings)].map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}
      </details>
    </section>
  );
}
