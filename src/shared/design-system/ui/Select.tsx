import type { ReactNode } from "react";
import { Field } from "./Field";
import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, CaretDownIcon } from "../icons/index";
import { Button } from "./Button";

export type SelectGroup = {
  label: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
};

/** A compact, labelled single-choice control with accessible option groups. */
export function Select({
  label,
  value,
  groups,
  onValueChange,
  variant = "inline",
  disabled = false,
  description,
  error,
  name,
  required,
  readOnly,
  placeholder,
}: {
  label: string;
  description?: ReactNode;
  error?: ReactNode;
  name?: string;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  variant?: "inline" | "field";
  disabled?: boolean;
  value: string;
  groups: readonly SelectGroup[];
  onValueChange: (value: string) => void;
}) {
  const control = (
    <div
      data-buzz-ui=""
      className="buzz-select text-body"
      data-variant={variant}
    >
      <BaseSelect.Root
        disabled={disabled}
        name={name}
        required={required}
        readOnly={readOnly}
        value={value || null}
        items={groups.flatMap((group) => group.options)}
        onValueChange={(next) => {
          if (next !== null) onValueChange(next);
        }}
      >
        {variant === "inline" && (
          <BaseSelect.Label className="text-primary">{label}</BaseSelect.Label>
        )}
        {variant === "field" ? (
          <BaseSelect.Trigger
            data-buzz-ui=""
            className="buzz-input buzz-select-trigger"
          >
            <BaseSelect.Value
              className="buzz-select-value"
              placeholder={placeholder}
            />
            <BaseSelect.Icon>
              <CaretDownIcon
                size={16}
                className="buzz-dropdown-chevron"
                aria-hidden="true"
              />
            </BaseSelect.Icon>
          </BaseSelect.Trigger>
        ) : (
          <BaseSelect.Trigger
            render={(props) => (
              <Button {...props} variant="ghost">
                <BaseSelect.Value placeholder={placeholder} />
                <BaseSelect.Icon>
                  <CaretDownIcon
                    size={14}
                    className="buzz-dropdown-chevron"
                    aria-hidden="true"
                  />
                </BaseSelect.Icon>
              </Button>
            )}
          />
        )}
        <BaseSelect.Portal>
          <BaseSelect.Positioner
            className="buzz-select-positioner"
            sideOffset={4}
            align="start"
            alignItemWithTrigger={false}
          >
            <BaseSelect.Popup
              data-buzz-ui=""
              className="buzz-select-popup text-body"
              data-variant={variant}
            >
              <BaseSelect.List>
                {groups.map((group) => (
                  <BaseSelect.Group key={group.label}>
                    {group.label && (
                      <BaseSelect.GroupLabel className="buzz-select-group-label text-secondary">
                        {group.label}
                      </BaseSelect.GroupLabel>
                    )}
                    {group.options.map((option) => (
                      <BaseSelect.Item
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                        className="buzz-select-option"
                      >
                        <BaseSelect.ItemText>
                          {option.label}
                        </BaseSelect.ItemText>
                        <BaseSelect.ItemIndicator>
                          <CheckIcon size={14} aria-hidden="true" />
                        </BaseSelect.ItemIndicator>
                      </BaseSelect.Item>
                    ))}
                  </BaseSelect.Group>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
  return variant === "field" ? (
    <Field
      nativeLabel={false}
      label={label}
      description={description}
      error={error}
      disabled={disabled}
    >
      {control}
    </Field>
  ) : (
    control
  );
}
