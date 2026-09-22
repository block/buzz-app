import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, CaretDownIcon } from "../icons/index";
import { Button } from "./Button";

export type SelectGroup = {
  label: string;
  options: readonly { value: string; label: string }[];
};

/** A compact, labelled single-choice control with accessible option groups. */
export function Select({
  label,
  value,
  groups,
  onValueChange,
  variant = "inline",
  disabled = false,
}: {
  label: string;
  variant?: "inline" | "field";
  disabled?: boolean;
  value: string;
  groups: readonly SelectGroup[];
  onValueChange: (value: string) => void;
}) {
  return (
    <div
      data-buzz-ui=""
      className="buzz-select text-body"
      data-variant={variant}
    >
      <BaseSelect.Root
        disabled={disabled}
        value={value}
        items={groups.flatMap((group) => group.options)}
        onValueChange={(next) => {
          if (next !== null) onValueChange(next);
        }}
      >
        <BaseSelect.Label
          className={variant === "field" ? "buzz-field-label" : "text-primary"}
        >
          {label}
        </BaseSelect.Label>
        {variant === "field" ? (
          <BaseSelect.Trigger
            data-buzz-ui=""
            className="buzz-input buzz-select-trigger"
          >
            <BaseSelect.Value className="buzz-select-value" />
            <BaseSelect.Icon>
              <CaretDownIcon size={16} aria-hidden="true" />
            </BaseSelect.Icon>
          </BaseSelect.Trigger>
        ) : (
          <BaseSelect.Trigger
            render={(props) => (
              <Button {...props} variant="ghost">
                <BaseSelect.Value />
                <BaseSelect.Icon>
                  <CaretDownIcon size={14} aria-hidden="true" />
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
}
