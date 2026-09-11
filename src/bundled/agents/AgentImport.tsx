import { useState } from "react";
import type {
  AgentControl,
  AgentImportPreview,
  ImportSource,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";

export function AgentImport({
  control,
  disabled,
}: {
  control: AgentControl;
  disabled: boolean;
}) {
  const [source, setSource] = useState<ImportSource>("installed");
  const [preview, setPreview] = useState<AgentImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <details className="space-y-4">
      <summary className="cursor-pointer text-body font-semibold">
        Import from old Buzz
      </summary>
      <p className="text-body-sm text-secondary">
        Preview reads only the selected library. Import preserves exact
        identities and leaves them disabled; it does not enroll or start agents.
        Close old Buzz before starting imported agents here.
      </p>
      <fieldset disabled={disabled} className="space-y-3">
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
                  setPreview(null);
                  setSelected([]);
                  setNotice(null);
                }}
              />
              {value === "installed" ? "Installed Buzz" : "Development Buzz"}
            </label>
          ))}
        </div>
        <Button
          disabled={disabled}
          onClick={() => {
            setPreview(null);
            setSelected([]);
            setNotice(null);
            void control
              .previewImport(source)
              .then(setPreview)
              .catch(() => {});
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
            disabled={disabled || !selected.length}
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
