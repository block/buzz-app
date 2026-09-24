import { Select } from "../../shared/design-system/ui/Select";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useState } from "react";
import type { ControlSnapshot } from "../../features/agents/control";
import { isGoose, type AgentDraft } from "./agent-edit";

/** Choices come from the injected native snapshot, never a plugin runtime catalog. */
export function AgentHarnessEditor({
  draft,
  options,
  onChange,
  disabled = false,
}: {
  draft: AgentDraft;
  options: NonNullable<ControlSnapshot["harnessOptions"]>;
  disabled?: boolean;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const harness =
    options.find((option) => option.command === draft.command) ??
    (isGoose(draft.command)
      ? options.find((option) => isGoose(option.command))
      : undefined);
  return (
    <div className="space-y-4">
      <ConfigChoice
        disabled={disabled}
        label="Harness"
        customLabel="Custom executable / current value"
        inputLabel="Executable"
        value={draft.command}
        options={options.map(({ command, label, available }) => ({
          value: command,
          label: available === false ? `${label} (install first)` : label,
          disabled: available === false,
        }))}
        onChange={(command, pickedOption) => {
          const option = options.find((item) => item.command === command);
          const enteringGoose = isGoose(command);
          const leavingGoose = isGoose(draft.command);
          onChange({
            command,
            ...(pickedOption && (enteringGoose || leavingGoose)
              ? {
                  args: JSON.stringify(option?.defaultArgs ?? []),
                  provider: enteringGoose
                    ? ""
                    : (option?.providers[0]?.value ?? ""),
                  model: "",
                }
              : {}),
          });
        }}
      />
      {options.some(
        (option) => isGoose(option.command) && option.available === false,
      ) && (
        <p className="text-body-sm text-secondary">
          Install the Goose CLI to use it as a harness.
        </p>
      )}
      <ConfigChoice
        disabled={disabled}
        label={isGoose(draft.command) ? "LLM Provider" : "Provider"}
        customLabel="Custom provider / current value"
        inputLabel="Custom provider"
        value={draft.provider}
        options={[
          { value: "", label: "Not set" },
          ...(harness?.providers ?? []),
        ]}
        onChange={(provider) =>
          onChange({
            provider,
            ...(isGoose(draft.command) ? { model: "" } : {}),
          })
        }
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
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange(value: string, pickedOption: boolean): void;
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
                disabled: option.disabled ?? false,
              })),
              { value: "custom", label: customLabel },
            ],
          },
        ]}
        onValueChange={(selected) => {
          setCustom(selected === "custom");
          if (selected !== "custom") {
            const option = options[Number(selected)];
            if (option) onChange(option.value, true);
          }
        }}
      />
      {showInput && (
        <Field label={inputLabel}>
          <Input
            disabled={disabled}
            value={value}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value, false)}
          />
        </Field>
      )}
    </div>
  );
}
