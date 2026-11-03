import { sourceLabel } from "../conversation-import/protocol";
import type { ChannelMessage } from "../relay/contracts";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Messages.module.css";

/** A Buzz edit, or an edit the import source recorded before the message
 * was imported. Only the former changes how mentions bind. */
export function markedEdited(row: ChannelMessage) {
  return !!row.edited || !!row.imported?.sourceEdited;
}

/** `compact` is for continuation rows, which show no byline. */
export function ImportedMarker({
  imported,
  compact = false,
}: {
  imported: NonNullable<ChannelMessage["imported"]>;
  compact?: boolean;
}) {
  const label = sourceLabel(imported.source);
  return (
    <Tooltip
      content={`Imported from ${label}. The time shown is when it was originally sent.`}
      disableHoverablePopup
    >
      <span
        className={`${styles.importedMarker} select-none`}
        data-imported-marker=""
      >
        {compact ? (
          "Imported"
        ) : (
          <>
            <span aria-hidden="true">· </span>
            Imported from {label} · original time
          </>
        )}
      </span>
    </Tooltip>
  );
}
