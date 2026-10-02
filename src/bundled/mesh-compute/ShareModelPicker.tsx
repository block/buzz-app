import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";

type Catalog = {
  gpuName: string | null;
  vramDisplay: string;
  recommended: string | null;
  entries: {
    model: string;
    name: string;
    size: string | null;
    installed: boolean;
    curated: boolean;
    fit: string;
  }[];
};
const CUSTOM = "__custom__";

export function ShareModelPicker({
  model,
  onChange,
  disabled,
}: {
  model: string;
  onChange: (model: string) => void;
  disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const id = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the catalog read.
  useEffect(() => {
    let active = true;
    setError(null);
    void invoke<Catalog>("mesh_compute_catalog")
      .then((result) => {
        if (!Array.isArray(result.entries))
          throw new Error("Invalid Mesh model catalog");
        if (active) setCatalog(result);
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (!model && !custom && catalog?.recommended)
      onChange(catalog.recommended);
  }, [catalog, model, custom, onChange]);
  const entry = catalog?.entries.find((entry) => entry.model === model);
  return (
    <div>
      {catalog && (
        <p className="text-body-sm text-secondary">
          {catalog.gpuName ?? "Hardware"} · {catalog.vramDisplay} AI memory
        </p>
      )}
      {error ? (
        <p role="alert">
          {error}{" "}
          <Button disabled={disabled} onClick={() => setAttempt(attempt + 1)}>
            Retry model catalog
          </Button>
        </p>
      ) : (
        !catalog && <p role="status">Loading model choices…</p>
      )}
      {catalog && (
        <Select
          label="Model to share"
          value={custom || (model && !entry) ? CUSTOM : model}
          disabled={disabled}
          onValueChange={(value) => {
            setCustom(value === CUSTOM);
            onChange(value === CUSTOM ? "" : value);
          }}
          groups={[
            {
              label: "Recommended and curated",
              options: catalog.entries
                .filter((entry) => entry.curated)
                .map((entry) => ({
                  value: entry.model,
                  label: `${entry.name}${entry.model === catalog.recommended ? " — recommended" : ""}${entry.size ? ` · ${entry.size}` : ""}${entry.installed ? " · installed" : " · download"}`,
                })),
            },
            {
              label: "Advanced",
              options: [
                ...catalog.entries
                  .filter((entry) => !entry.curated)
                  .map((entry) => ({
                    value: entry.model,
                    label: `${entry.name}${entry.size ? ` · ${entry.size}` : ""}${entry.installed ? " · installed" : " · download"}`,
                  })),
                { value: CUSTOM, label: "Custom model or local GGUF" },
              ],
            },
          ]}
        />
      )}
      {entry && (
        <p className="text-body-sm text-secondary">
          {entry.installed
            ? "Already installed"
            : `Downloads ${entry.size ?? "model weights"} when you share`}
          . Memory fit: {entry.fit.replaceAll("_", " ")}.
        </p>
      )}
      {(custom ||
        !catalog ||
        catalog.entries.length === 0 ||
        (model && !entry)) && (
        <label htmlFor={id} className="text-body-sm">
          Model reference or local GGUF path
          <Input
            id={id}
            value={model}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          />
        </label>
      )}
    </div>
  );
}
