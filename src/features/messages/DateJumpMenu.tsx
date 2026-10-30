import {
  createContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Calendar } from "../../shared/design-system/ui/Calendar";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { dayStart, jumpStart, type JumpChoice } from "./date-jump";
import styles from "./Messages.module.css";

/** Jumps the channel timeline to the first message at or after `from` (unix seconds). */
export const DateJumpContext = createContext<
  ((from: number) => void) | undefined
>(undefined);

const choices: readonly { choice: JumpChoice; label: string }[] = [
  { choice: "today", label: "Today" },
  { choice: "yesterday", label: "Yesterday" },
  { choice: "lastWeek", label: "Last week" },
  { choice: "lastMonth", label: "Last month" },
  { choice: "beginning", label: "The very beginning" },
];

/** A day divider's label as a "Jump to…" menu trigger. */
export function DateJumpMenu({
  label,
  jump,
  children,
}: {
  label: string;
  jump(from: number): void;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <MenuRoot>
        <MenuTrigger
          render={
            <Button
              ref={trigger}
              variant="plain"
              size="inline"
              shape="control"
              aria-label={`${label}, jump to date`}
            >
              <span className={styles.dayJump}>
                {children}
                <CaretDownIcon
                  className={styles.dayJumpChevron}
                  aria-hidden="true"
                />
              </span>
            </Button>
          }
        />
        {/* The calendar takes focus; the menu must not return it to the trigger. */}
        <MenuPopup size="compact" align="center" finalFocus={!picking}>
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Jump to…</MenuGroupLabel>
            {choices.map(({ choice, label }) => (
              <MenuItem
                key={choice}
                onClick={() => jump(jumpStart(choice, new Date()))}
              >
                {label}
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => setPicking(true)}>
            Jump to a specific date
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      <DateJumpDialog
        open={picking}
        onOpenChange={setPicking}
        trigger={trigger}
        jump={jump}
      />
    </>
  );
}

/** A transient calendar: no navigation history, and a pick jumps at once. */
export function DateJumpDialog({
  open,
  onOpenChange,
  trigger,
  jump,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: RefObject<HTMLButtonElement | null>;
  jump(from: number): void;
}) {
  const today = new Date();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="compact"
      title="Jump to a specific date"
      description="Pick a day to see its first message."
      finalFocus={trigger}
    >
      <Calendar
        mode="single"
        captionLayout="dropdown"
        defaultMonth={today}
        startMonth={new Date(2000, 0)}
        endMonth={today}
        disabled={{ after: today }}
        autoFocus
        onSelect={(day) => {
          if (!day) return;
          onOpenChange(false);
          jump(dayStart(day));
        }}
      />
    </Dialog>
  );
}
