import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import styles from "./Compute.module.css";

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

const FIT_LABELS: Record<string, string> = {
  comfortable: "fits comfortably",
  tight: "fits, tight on memory",
  tradeoff: "may be slow on this machine",
  too_large: "too large for this machine",
};

export function ShareModelPicker({
  model,
  onChange,
  disabled,
  auto,
  onReset,
  resetDisabled,
  onRecommendation,
  runningModel,
}: {
  model: string;
  onChange: (model: string) => void;
  disabled: boolean;
  auto: boolean;
  onReset: () => void;
  onRecommendation?: (model: string | null) => void;
  runningModel?: string | null;
  resetDisabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const id = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the catalog read.
  useEffect(() => {
    let active = true;
    setError(null);
    const deadline = setTimeout(() => {
      if (active) {
        active = false;
        setError(
          "Model choices took too long to load. Retry, or choose a model under Advanced.",
        );
      }
    }, 30000);
    void invoke<Catalog>("mesh_compute_catalog")
      .then((result) => {
        if (!Array.isArray(result.entries))
          throw new Error("Invalid Mesh model catalog");
        if (active) {
          clearTimeout(deadline);
          setCatalog(result);
        }
      })
      .catch((error) => {
        if (active) {
          clearTimeout(deadline);
          setError(String(error));
        }
      });
    return () => {
      clearTimeout(deadline);
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    onRecommendation?.(catalog?.recommended ?? null);
  }, [catalog?.recommended, onRecommendation]);
  const displayModel = auto ? (catalog?.recommended ?? "") : model;
  const entry = catalog?.entries.find((entry) => entry.model === displayModel);
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
      {auto && (
        <p className="text-body">
          {catalog?.recommended
            ? `Auto — ${entry?.name ?? catalog.recommended} (${catalog.recommended.split(":").at(-1)}) for this device`
            : "Auto — chooses a model for this device when sharing starts."}
        </p>
      )}
      {entry && !advanced && !auto && (
        <p className="text-body">{entry.name} — selected model.</p>
      )}
      {catalog && !catalog.recommended && !model && !auto && (
        <p>No recommended model is available. Choose a model under Advanced.</p>
      )}
      {auto &&
        runningModel &&
        catalog?.recommended &&
        runningModel !== catalog.recommended && (
          <p className="text-body-sm text-secondary">
            Auto selection applies next time sharing starts.
          </p>
        )}
      {!auto && (
        <Button
          variant="ghost"
          size="sm"
          disabled={resetDisabled ?? disabled}
          onClick={() => {
            onReset();
            setCustom(false);
            setAdvanced(false);
          }}
        >
          Reset to Auto
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setAdvanced(!advanced)}
        aria-expanded={advanced}
      >
        Advanced
      </Button>
      {catalog && advanced && (
        <Select
          label="Model to share"
          variant="field"
          value={custom || (displayModel && !entry) ? CUSTOM : displayModel}
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
                  label: `${entry.name}${entry.model === catalog.recommended ? " — recommended" : ""}${optionDetail(entry)}`,
                  disabled: tooLarge(entry, displayModel),
                })),
            },
            {
              label: "Advanced",
              options: [
                ...catalog.entries
                  .filter((entry) => !entry.curated)
                  .map((entry) => ({
                    value: entry.model,
                    label: `${entry.name}${optionDetail(entry)}`,
                    disabled: tooLarge(entry, displayModel),
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
            ? "Downloaded"
            : `Downloads ${entry.size ?? "the model"} when sharing starts`}
          {entry.fit === "unknown" ? (
            "."
          ) : (
            <>
              {" · "}
              <span className={styles.fit} data-fit={entry.fit}>
                {fitLabel(entry.fit)}
              </span>
              .
            </>
          )}
        </p>
      )}
      {advanced &&
        (custom ||
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

const fitLabel = (fit: string) => FIT_LABELS[fit] ?? fit.replaceAll("_", " ");

function optionDetail(entry: Catalog["entries"][number]): string {
  return `${entry.size ? ` · ${entry.size}` : ""}${entry.installed ? " · installed" : " · download"}${entry.fit === "unknown" ? "" : ` · ${fitLabel(entry.fit)}`}`;
}

/** A model this machine can't hold is not offered, unless it's already chosen. */
const tooLarge = (entry: Catalog["entries"][number], selected: string) =>
  entry.fit === "too_large" && entry.model !== selected;
