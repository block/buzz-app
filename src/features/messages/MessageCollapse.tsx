import {
  ArrowsInIcon,
  ArrowsOutIcon,
  CaretDownIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import type { ChannelMessage } from "../relay/contracts";
import { plainText } from "../notifications/content";
import styles from "./Messages.module.css";

const label = (collapsed: boolean) =>
  collapsed ? "Expand message" : "Collapse message";

/** The toolbar's quick toggle. */
export function MessageCollapseButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle(): void;
}) {
  return (
    <IconButton
      aria-label={label(collapsed)}
      hint="familiar"
      title={label(collapsed)}
      size="sm"
      icon={collapsed ? <ArrowsOutIcon /> : <ArrowsInIcon />}
      onClick={onToggle}
    />
  );
}

/** The "More message actions" item. It opens nothing, so the menu returns
 * focus to its trigger as usual. */
export function MessageCollapseItem({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle(): void;
}) {
  return (
    <MenuItem onClick={onToggle}>
      <MenuIcon>{collapsed ? <ArrowsOutIcon /> : <ArrowsInIcon />}</MenuIcon>
      {label(collapsed)}
    </MenuItem>
  );
}

/** A collapsed message's one line: its plain opening text. */
export function CollapsedMessageLine({
  row,
  author,
  onExpand,
}: {
  row: ChannelMessage;
  author: string;
  /** `focused` when the line had focus, which leaves with it. */
  onExpand(focused: boolean): void;
}) {
  const text =
    (row.diff
      ? row.diff.description || row.diff.filePath
      : plainText(row.content)) ||
    (row.attachments.length ? "Attachments" : "Message");
  return (
    <button
      type="button"
      className={styles.collapsedLine}
      data-message-action-anchor
      data-collapsed-message
      aria-expanded={false}
      aria-label={`${author}, collapsed message: ${text}. Expand message`}
      onClick={(event) =>
        onExpand(document.activeElement === event.currentTarget)
      }
    >
      <span className={styles.collapsedText} aria-hidden="true">
        {text}
      </span>
      <CaretDownIcon className={styles.collapsedChevron} aria-hidden="true" />
    </button>
  );
}
