import { useEffect, useState } from "react";
import { EyeIcon, EyeSlashIcon } from "../../shared/design-system/icons/index";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";

/** The same write-only provider key input for agent and default settings. */
export function ProviderApiKeyField({
  apiKey,
  ...props
}: Omit<Parameters<typeof SecretField>[0], "label" | "noun"> & {
  apiKey: { label: string; env: string };
}) {
  return (
    <SecretField label={`${apiKey.label} API key`} noun="key" {...props} />
  );
}

/** A write-only input: the saved value is never shown, only whether one exists. */
export function SecretField({
  label,
  noun,
  value,
  saved,
  disabled,
  emptyPlaceholder,
  onChange,
}: {
  label: string;
  /** What the reveal button and placeholder call the value. */
  noun: "key" | "value";
  value: string | null | undefined;
  saved: boolean;
  disabled: boolean;
  emptyPlaceholder: string;
  onChange(value: string): void;
}) {
  const shown = noun === "key" ? "API key" : label;
  const [revealed, setRevealed] = useState(false);
  const typed = !!value;
  // Saving, discarding, or removing an environment patch may clear the input
  // outside this component. A later key must start masked again.
  useEffect(() => {
    if (!typed) setRevealed(false);
  }, [typed]);
  return (
    <Field label={label}>
      <InputGroup
        trailing={
          typed ? (
            <IconButton
              aria-label={revealed ? `Hide ${shown}` : `Show ${shown}`}
              icon={
                revealed ? (
                  <EyeSlashIcon size={16} aria-hidden="true" />
                ) : (
                  <EyeIcon size={16} aria-hidden="true" />
                )
              }
              size="sm"
              disabled={disabled}
              onClick={() => setRevealed(!revealed)}
            />
          ) : undefined
        }
      >
        <Input
          type={revealed && typed ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          value={value ?? ""}
          placeholder={
            value === null
              ? "Will remove on save"
              : saved
                ? `Saved ${noun} unchanged`
                : emptyPlaceholder
          }
          onChange={(event) => {
            if (!event.target.value) setRevealed(false);
            onChange(event.target.value);
          }}
        />
      </InputGroup>
    </Field>
  );
}
