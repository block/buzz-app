import { memo } from "react";
import { importRecordText } from "../conversation-import/protocol";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { DayDivider } from "./MessageTimestamp";
import styles from "./Messages.module.css";

/** A conversation import consent, withdrawal or completion, as a quiet
 * system line in the style of membership activity. */
export const ImportNoticeRow = memo(function ImportNoticeRow({
  row,
  profiles,
  viewer,
  day,
  resolveName,
}: {
  row: ChannelMessage;
  profiles: ReadonlyMap<string, Profile>;
  viewer?: string | undefined;
  day: boolean;
  resolveName?: (pubkey: string, fallback: string) => string;
}) {
  if (!row.importRecord) return null;
  const fallback =
    profiles.get(row.authorId)?.name ?? row.authorId.slice(0, 10);
  const name =
    row.authorId === viewer
      ? "You"
      : (resolveName?.(row.authorId, fallback) ?? fallback);
  const text = importRecordText(row.importRecord);
  return (
    <div data-message-id={row.id} data-import-notice-row="">
      {day && <DayDivider createdAt={row.createdAt} />}
      <div className={styles.membership} data-highlight-surface="">
        <p>
          <strong className={styles.importNoticeName}>{name}</strong>{" "}
          {text[0]?.toLowerCase()}
          {text.slice(1)}
        </p>
      </div>
    </div>
  );
});
