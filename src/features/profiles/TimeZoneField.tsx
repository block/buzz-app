import { useMemo, useState } from "react";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Combobox } from "../../shared/design-system/ui/Combobox";

const zoneLabel = (zone: string) => zone.replaceAll("_", " ");

/** Chooses the profile's shared `tz`. Undefined means none is shared; the
 * picker then offers this device's zone without choosing it. */
export function TimeZoneField({
  value,
  onChange,
  disabled = false,
}: {
  value: string | undefined;
  onChange(value: string | undefined): void;
  disabled?: boolean;
}) {
  const device = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shown = value ?? device;
  const zones = useMemo(
    () => [...new Set([shown, device, ...Intl.supportedValuesOf("timeZone")])],
    [shown, device],
  );
  const [search, setSearch] = useState("");
  return (
    <div className="grid gap-2">
      <Checkbox
        label="Show my local time on my profile"
        checked={value !== undefined}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? shown : undefined)}
      />
      <Combobox.Root
        items={zones}
        value={shown}
        itemToStringLabel={zoneLabel}
        inputValue={search}
        onInputValueChange={setSearch}
        onOpenChange={(open) => {
          if (open) setSearch("");
        }}
        autoHighlight
        disabled={disabled || value === undefined}
        onValueChange={(zone) => {
          if (zone) onChange(zone);
        }}
      >
        <Combobox.Trigger
          label="Time zone"
          disabled={disabled || value === undefined}
        >
          {zoneLabel(shown)}
        </Combobox.Trigger>
        <Combobox.Popup
          search
          size="compact"
          side="bottom"
          collisionAvoidance={{ side: "none", align: "shift" }}
          empty="No matching time zones."
        >
          <Combobox.List>
            {(zone: string) => (
              <Combobox.Item key={zone} value={zone}>
                {zoneLabel(zone)}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </div>
  );
}
