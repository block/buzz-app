import { useState, type ReactNode } from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { schedulePresets } from "./schedule-time";
export function ScheduleMessageMenu({
  children,
  disabled,
  custom,
  schedule,
}: {
  children: ReactNode;
  disabled: boolean;
  custom(): void;
  schedule(time: number): Promise<boolean | undefined>;
}) {
  const [handoff, setHandoff] = useState(false);
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups send actions, not form fields.
    <div
      data-buzz-ui=""
      className="buzz-split-button"
      data-variant="prominent"
      role="group"
      aria-label="Send options"
    >
      {children}
      <MenuRoot
        onOpenChange={(open) => {
          if (open) setHandoff(false);
        }}
      >
        <MenuTrigger
          disabled={disabled}
          render={
            <IconButton
              type="button"
              size="toolbar"
              aria-label="Schedule message"
              title="Schedule message"
              disabled={disabled}
              icon={<CaretDownIcon size={16} />}
            />
          }
        />
        <MenuPopup
          align="end"
          side="top"
          size="compact"
          finalFocus={handoff ? false : undefined}
        >
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Schedule message</MenuGroupLabel>
            {schedulePresets().map((preset) => (
              <MenuItem
                key={preset.label}
                onClick={() => void schedule(preset.time)}
              >
                {preset.label}
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              setHandoff(true);
              custom();
            }}
          >
            Custom time
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}
