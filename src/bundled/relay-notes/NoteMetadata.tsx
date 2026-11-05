import type { NoteEvent } from "../../features/notes/model";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./NotesPage.module.css";

export function NoteByline({
  note,
  author,
  picture,
  status,
  isAgent = false,
}: {
  note: NoteEvent;
  author: string;
  picture?: string | undefined;
  status?: string | undefined;
  isAgent?: boolean;
}) {
  return (
    <p className={`${styles.byline} text-caption text-secondary`}>
      <NoteAuthor name={author} picture={picture} isAgent={isAgent} /> ·
      <span role={status ? "status" : undefined}>
        {status && status !== "Saved" && status !== "Deleted" ? (
          status
        ) : (
          <>
            {status === "Deleted" ? "Deleted" : "Saved"}{" "}
            <NoteTime note={note} />
          </>
        )}
      </span>
    </p>
  );
}

export function NoteTime({ note }: { note: Pick<NoteEvent, "created_at"> }) {
  const date = new Date(note.created_at * 1000);
  const days = Math.floor((Date.now() / 1000 - note.created_at) / 86400);
  // The shared recency ladder switches to calendar dates after a week; notes
  // keep older timestamps relative too, with the exact date in the title.
  const label =
    days >= 7
      ? new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(
          -days,
          "day",
        )
      : relativeTimestamp(note.created_at);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      })}
    >
      {label}
    </time>
  );
}

function NoteAuthor({
  name,
  picture,
  isAgent,
}: {
  name: string;
  picture?: string | undefined;
  isAgent: boolean;
}) {
  return (
    <span className={styles.byline}>
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size="compact"
        shape={isAgent ? "squircle" : "circle"}
      />
      <span>{name}</span>
    </span>
  );
}
