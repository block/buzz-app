import { useState } from "react";
import type {
  AgentControl,
  ControlSnapshot,
} from "../../features/agents/control";
import { AgentModelPicker } from "./AgentModelPicker";
import type { AgentDraft } from "./agent-edit";

/** Choices come from the injected native snapshot, never a plugin runtime catalog. */
export function AgentHarnessEditor({
  draft,
  id,
  savedRevision,
  control,
  defaults,
  options,
  onChange,
}: {
  draft: AgentDraft;
  id: string;
  savedRevision: number;
  control: AgentControl;
  defaults: ControlSnapshot["databricksDefaults"];
  options: NonNullable<ControlSnapshot["harnessOptions"]>;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const harness = options.find((option) => option.command === draft.command);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <ConfigChoice
          label="Harness"
          customLabel="Custom executable / current value"
          inputLabel="Executable"
          value={draft.command}
          options={options.map(({ command, label }) => ({
            value: command,
            label,
          }))}
          onChange={(command) => onChange({ command })}
        />
        <ConfigChoice
          label="Provider"
          customLabel="Custom provider / current value"
          inputLabel="Custom provider"
          value={draft.provider}
          options={[
            { value: "", label: "Not set" },
            ...(harness?.providers ?? []),
          ]}
          onChange={(provider) => onChange({ provider })}
        />
      </div>
      <AgentModelPicker
        savedRevision={savedRevision}
        id={id}
        draft={draft}
        control={control}
        defaults={defaults}
        onChange={onChange}
      />
    </div>
  );
}

function ConfigChoice({
  label,
  customLabel,
  inputLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  customLabel: string;
  inputLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
}) {
  // Custom is an editing mode, not a saved value. Entering it never erases data.
  const [custom, setCustom] = useState(false);
  const index = options.findIndex((option) => option.value === value);
  const showInput = custom || index < 0;
  return (
    <div className="min-w-0 space-y-3">
      <label className="agent-control-field">
        {label}
        <select
          value={showInput ? "custom" : String(index)}
          onChange={(event) => {
            const selected = event.target.value;
            setCustom(selected === "custom");
            if (selected !== "custom") {
              const option = options[Number(selected)];
              if (option) onChange(option.value);
            }
          }}
        >
          {options.map((option, i) => (
            <option key={option.value} value={String(i)}>
              {option.label}
            </option>
          ))}
          <option value="custom">{customLabel}</option>
        </select>
      </label>
      {showInput && (
        <label className="agent-control-field">
          {inputLabel}
          <input
            value={value}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}
