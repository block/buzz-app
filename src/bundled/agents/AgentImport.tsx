import { useRef, useState } from "react";
import type {
  AgentControl,
  AgentImportPreview,
  ImportSource,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";

export function AgentImport({
  control,
  disabled,
  commitAvailable = true,
}: {
  control: AgentControl;
  disabled: boolean;
  commitAvailable?: boolean;
}) {
  const [source, setSource] = useState<ImportSource>("installed");
  const [destination, setDestination] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const generation = useRef(0);
  const [preview, setPreview] = useState<AgentImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const invalidatePreview = () => {
    generation.current++;
    setPreview(null);
    setSelected([]);
    setNotice(null);
  };
  return (
    <details className="space-y-4">
      <summary className="cursor-pointer text-body font-semibold">
        Import from old Buzz
      </summary>
      <p className="text-body-sm text-secondary">
        Preview reads only the selected library, without Keychain access. When
        available, import preserves exact identities and leaves them disabled;
        it does not enroll or start agents. Keep old Buzz running for replies
        during this editing checkpoint.
      </p>
      {!commitAvailable && (
        <p role="status">
          Import is disabled in this integration checkpoint. Preview does not
          access Keychain; credential acceptance is still pending.
        </p>
      )}
      <fieldset disabled={disabled && !previewing} className="space-y-3">
        <legend className="text-body font-semibold">Source library</legend>
        <div className="flex flex-wrap gap-4">
          {(["installed", "development"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="agent-import-source"
                value={value}
                checked={source === value}
                onChange={() => {
                  setSource(value);
                  invalidatePreview();
                }}
              />
              {value === "installed" ? "Installed Buzz" : "Development Buzz"}
            </label>
          ))}
        </div>
        <label className="block space-y-1">
          <span>Destination community</span>
          <input
            className="w-full rounded border border-primary bg-panel p-2"
            type="text"
            value={destination}
            placeholder="wss://community.example"
            spellCheck={false}
            onChange={(event) => {
              setDestination(event.target.value);
              invalidatePreview();
            }}
          />
        </label>
        <p className="text-body-sm text-secondary">
          Choose the secure community origin for these identities. Old saved
          relay values are not used. Import does not join or start agents there.
        </p>
        <Button
          disabled={disabled || previewing || !destination.trim()}
          onClick={() => {
            invalidatePreview();
            const current = generation.current;
            setPreviewing(true);
            void control
              .previewImport(source, destination)
              .then((result) => {
                if (generation.current === current) setPreview(result);
              })
              .catch(() => {})
              .finally(() => setPreviewing(false));
          }}
        >
          Preview selected library
        </Button>
      </fieldset>
      {preview && (
        <div className="space-y-3">
          <p className="break-all font-mono text-mono-sm">
            {preview.sourcePath}
          </p>
          {[...new Set(preview.warnings)].map((warning) => (
            <p key={warning} className="text-amber-12 text-body-sm">
              {warning}
            </p>
          ))}
          {!preview.candidates.length && (
            <p>No importable identities in this library.</p>
          )}
          {preview.candidates.map((candidate) => (
            <label
              key={candidate.id}
              className="flex items-start gap-3 border-t border-primary pt-3"
            >
              <input
                type="checkbox"
                className="mt-1"
                disabled={disabled}
                checked={selected.includes(candidate.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, candidate.id]
                      : selected.filter((id) => id !== candidate.id),
                  )
                }
              />
              <span className="min-w-0 space-y-1">
                <span className="block font-semibold">{candidate.name}</span>
                <span className="block break-all font-mono text-mono-sm">
                  {candidate.pubkey}
                </span>
                <span className="block break-all font-mono text-mono-sm text-secondary">
                  {candidate.relayUrl}
                </span>
              </span>
            </label>
          ))}
          <Button
            disabled={disabled || !selected.length || !commitAvailable}
            onClick={() => {
              void control
                .commitImport(preview.token, selected)
                .then(() => {
                  setPreview(null);
                  setSelected([]);
                  setNotice(
                    "Imported with agents disabled. Review their settings before starting.",
                  );
                })
                .catch(() => {});
            }}
          >
            Import selected identities
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-secondary">
          {notice}
        </p>
      )}
    </details>
  );
}
