import { useMemo } from "react";
import { Select } from "@base-ui/react/select";
import type { SelectGroup } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";
import { CaretDownIcon, CheckIcon } from "../../shared/design-system/icons";

/** Inbox's compact filters keep the option identity stable across row updates. */
export function InboxFilter({
  label,
  value,
  groups,
  onValueChange,
}: {
  label: string;
  value: string;
  groups: readonly SelectGroup[];
  onValueChange(value: string): void;
}) {
  const items = useMemo(
    () => groups.flatMap((group) => group.options),
    [groups],
  );
  return (
    <div
      data-buzz-ui=""
      className="buzz-select text-body"
      data-variant="compact"
    >
      <Select.Root
        value={value}
        items={items}
        onValueChange={(next) => {
          if (next !== null) onValueChange(next);
        }}
      >
        <Select.Label className="sr-only">{label}</Select.Label>
        <Select.Trigger
          render={(props) => (
            <Button {...props} variant="outline" size="sm">
              <Select.Value className="buzz-select-value" />
              <Select.Icon>
                <CaretDownIcon
                  size={14}
                  className="buzz-dropdown-chevron"
                  aria-hidden="true"
                />
              </Select.Icon>
            </Button>
          )}
        />
        <Select.Portal>
          <Select.Positioner
            className="buzz-select-positioner"
            sideOffset={4}
            align="start"
            alignItemWithTrigger={false}
          >
            <Select.Popup
              data-buzz-ui=""
              className="buzz-select-popup text-body"
              data-variant="compact"
            >
              <Select.List>
                {items.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className="buzz-select-option"
                  >
                    <Select.ItemText>{option.label}</Select.ItemText>
                    <Select.ItemIndicator
                      className="buzz-select-indicator"
                      keepMounted
                    >
                      <CheckIcon size={14} aria-hidden="true" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
