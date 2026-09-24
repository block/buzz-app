import { Select } from "../../shared/design-system/ui/Select";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useState } from "react";
import type { ControlSnapshot } from "../../features/agents/control";
import type { AgentDraft } from "./agent-edit";

/** Choices come from the injected native snapshot, never a plugin runtime catalog. */
export function AgentHarnessEditor({
  draft,
  options,
  defaultProvider,
  onChange,
  disabled = false,
}: {
  draft: AgentDraft;
  options: NonNullable<ControlSnapshot["harnessOptions"]>;
  disabled?: boolean;
  defaultProvider?: string | undefined;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const harness = options.find((option) => option.command === draft.command);
  return (
    <div className="space-y-4">
      <ConfigChoice
        disabled={disabled}
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
        disabled={disabled}
        label="Provider"
        customLabel="Custom provider / current value"
        inputLabel="Custom provider"
        value={draft.provider}
        options={[
          {
            value: "",
            label:
              draft.command === "buzz-agent" && defaultProvider
                ? `Build default (${defaultProvider})`
                : "Not set",
          },
          ...(harness?.providers ?? []),
        ]}
        onChange={(provider) => onChange({ provider })}
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
  disabled = false,
}: {
  label: string;
  customLabel: string;
  inputLabel: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange(value: string): void;
}) {
  // Custom is an editing mode, not a saved value. Entering it never erases data.
  const [custom, setCustom] = useState(false);
  const index = options.findIndex((option) => option.value === value);
  const showInput = custom || index < 0;
  return (
    <div className="min-w-0 space-y-3">
      <Select
        label={label}
        variant="field"
        disabled={disabled}
        value={showInput ? "custom" : String(index)}
        groups={[
          {
            label: "",
            options: [
              ...options.map((option, i) => ({
                value: String(i),
                label: option.label,
              })),
              { value: "custom", label: customLabel },
            ],
          },
        ]}
        onValueChange={(selected) => {
          setCustom(selected === "custom");
          if (selected !== "custom") {
            const option = options[Number(selected)];
            if (option) onChange(option.value);
          }
        }}
      />
      {showInput && (
        <Field label={inputLabel}>
          <Input
            disabled={disabled}
            value={value}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        </Field>
      )}
    </div>
  );
}
