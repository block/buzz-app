import {
  ArrowsInIcon,
  ArrowsOutIcon,
  CaretDownIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import type { ChannelMessage } from "../relay/contracts";
import { plainText } from "../notifications/content";
import { useAfterMessageMenuClose } from "./MessageActionBar";
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

/** The "More message actions" item; toggles once the menu has closed. */
export function MessageCollapseItem({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle(): void;
}) {
  const afterClose = useAfterMessageMenuClose();
  return (
    <MenuItem onClick={() => (afterClose ? afterClose(onToggle) : onToggle())}>
      <MenuIcon>{collapsed ? <ArrowsOutIcon /> : <ArrowsInIcon />}</MenuIcon>
      {label(collapsed)}
    </MenuItem>
  );
}

/** A collapsed message's one line: the author's tl;dr, labelled and in italics,
 * or its plain opening text when it has none, so an excerpt never reads as a
 * summary. */
export function CollapsedMessageLine({
  row,
  author,
  onExpand,
}: {
  row: ChannelMessage;
  author: string;
  onExpand(): void;
}) {
  const tldr = row.tldr;
  const text =
    tldr ??
    ((row.diff
      ? row.diff.description || row.diff.filePath
      : plainText(row.content)) ||
      (row.attachments.length ? "Attachments" : "Message"));
  return (
    <button
      type="button"
      className={styles.collapsedLine}
      data-message-action-anchor
      data-collapsed-message={tldr ? "tldr" : "excerpt"}
      aria-expanded={false}
      aria-label={`${author}, ${tldr ? `TL;DR: ${text}` : `collapsed message: ${text}`}. Expand message`}
      onClick={onExpand}
    >
      {tldr && (
        <span className={styles.collapsedLabel} aria-hidden="true">
          TL;DR
        </span>
      )}
      <span
        className={`${styles.collapsedText} ${tldr ? styles.collapsedTldr : ""}`}
        aria-hidden="true"
      >
        {text}
      </span>
      <CaretDownIcon className={styles.collapsedChevron} aria-hidden="true" />
    </button>
  );
}
