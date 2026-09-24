import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  AgentImportPreview,
  AgentView,
  ImportSource,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";

export function AgentImport({
  control,
  disabled,
  initialDestination = "",
  managedAgents,
  commitAvailable = true,
  onImported,
}: {
  control: AgentControl;
  disabled: boolean;
  initialDestination?: string;
  managedAgents: readonly AgentView[];
  commitAvailable?: boolean;
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
    if (initialDestination) void load("installed", initialDestination);
    return () => {
      generation.current++;
    };
  }, [initialDestination, load]);
  // Native import rejects any key already held locally, in any community.
  const managedKeys = new Set(
    managedAgents.map((agent) => agent.pubkey.toLowerCase()),
  );
  const candidates = preview?.candidates.filter(
    (candidate) =>
      !managedAgents.some((agent) => agent.id === candidate.id) &&
      !managedKeys.has(candidate.pubkey.toLowerCase()),
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
      {!commitAvailable && (
        <p role="status">Import is unavailable in this app session.</p>
      )}
      {previewing && <p role="status">Loading agents from old Buzz…</p>}
      {error && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">{error}</p>
          <Button
            disabled={disabled || !destination.trim()}
            onClick={() => void load(source, destination)}
          >
            Retry
          </Button>
        </div>
      )}
      {candidates?.length === 0 && (
        <p>No agents left to import from this library for this community.</p>
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
          <Button
            disabled={disabled || previewing || !commitAvailable}
            aria-label={`Import ${candidate.name}`}
            onClick={() => {
              if (!preview) return;
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
          className="flex flex-col gap-4 pt-4"
        >
          <Select
            label="Source library"
            variant="field"
            disabled={disabled && !previewing}
            value={source}
            groups={[
              {
                label: "",
                options: [
                  { value: "installed", label: "Installed Buzz" },
                  { value: "development", label: "Development Buzz" },
                ],
              },
            ]}
            onValueChange={(value) => {
              const next = value as ImportSource;
              setSource(next);
              invalidatePreview();
              if (destination.trim() && !disabled) void load(next, destination);
            }}
          />
          <Field label="Destination community">
            <Input
              value={destination}
              placeholder="https://community.example"
              spellCheck={false}
              onValueChange={(value) => {
                setDestination(value);
                invalidatePreview();
              }}
            />
          </Field>
          <Button
            disabled={disabled || previewing || !destination.trim()}
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
