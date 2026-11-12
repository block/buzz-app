import { useMemo, useState } from "react";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Combobox } from "../../shared/design-system/ui/Combobox";

const zoneLabel = (zone: string) => zone.replaceAll("_", " ");

// Renamed zones some engines still list only by their old name (V8 lists
// Asia/Calcutta, not Asia/Kolkata), so search finds either spelling.
const renamed: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};
const aliases = new Map(
  Object.entries(renamed).flatMap(([old, current]) => [
    [old, current],
    [current, old],
  ]),
);
const searchable = (text: string) => zoneLabel(text).toLowerCase();
function matches(zone: string, query: string) {
  const needle = searchable(query.trim());
  const alias = aliases.get(zone);
  return (
    searchable(zone).includes(needle) ||
    (!!alias && searchable(alias).includes(needle))
  );
}

/** Chooses the profile's shared `tz`, written exactly as picked. Undefined
 * means none is shared; the picker then offers this device's zone. */
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
    () => [
      ...new Set([
        shown,
        device,
        ...Intl.supportedValuesOf("timeZone"),
        // Some engines leave UTC out of their list.
        "UTC",
      ]),
    ],
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
        filter={matches}
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
              <Combobox.Item
                key={zone}
                value={zone}
                description={
                  renamed[zone] ? `Now ${zoneLabel(renamed[zone])}` : undefined
                }
              >
                {zoneLabel(zone)}
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </div>
  );
}
