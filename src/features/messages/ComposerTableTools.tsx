import { forwardRef, type KeyboardEvent } from "react";
import {
  ColumnInsertLeftIcon,
  ColumnInsertRightIcon,
  ColumnRemoveIcon,
  RowInsertBottomIcon,
  RowInsertTopIcon,
  RowRemoveIcon,
  TableOffIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { TableCommand } from "./composer-dom";
import styles from "./ComposerTableTools.module.css";

const groups = [
  [
    ["row_above", "Add row above", RowInsertTopIcon],
    ["row_below", "Add row below", RowInsertBottomIcon],
    ["column_left", "Add column left", ColumnInsertLeftIcon],
    ["column_right", "Add column right", ColumnInsertRightIcon],
  ],
  [
    ["delete_row", "Delete row", RowRemoveIcon],
    ["delete_column", "Delete column", ColumnRemoveIcon],
    ["delete_table", "Delete table", TableOffIcon],
  ],
] as const;

export const ComposerTableTools = forwardRef<
  HTMLDivElement,
  {
    disabled: boolean;
    header: boolean;
    run(command: TableCommand): void;
    focusEditor(): void;
  }
>(function ComposerTableTools({ disabled, header, run, focusEditor }, ref) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      focusEditor();
      return;
    }
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!buttons.length || index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
  };
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Table"
      className={styles.tools}
      onKeyDownCapture={move}
    >
      {groups.map((group) => (
        <div key={group[0][0]} className={styles.group}>
          {group.map(([command, label, Icon]) => (
            <IconButton
              key={command}
              hint="familiar"
              size="sm"
              variant="ghost"
              aria-label={label}
              title={label}
              disabled={disabled || (command === "row_above" && header)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(command)}
              icon={<Icon size={16} />}
            />
          ))}
        </div>
      ))}
    </div>
  );
});
