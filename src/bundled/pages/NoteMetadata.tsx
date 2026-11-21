import type { Note, NoteEvent } from "./model";
import type { ComponentProps } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./NotesPage.module.css";

export function noteDisplayTitle(note: Note, retainedTitle?: string) {
  if (!note.deleted) return note.title;
  return retainedTitle ? `${retainedTitle} (in Trash)` : "Doc in Trash";
}

export function NoteBylinePlaceholder() {
  return (
    <div className={styles.byline} aria-hidden="true">
      <Avatar
        alt=""
        fallback=""
        fallbackContent=""
        size="compact"
        shape="squircle"
      />
      <span className="h-2 w-12 rounded-full bg-affordance-disabled" />
      <span className="h-2 w-24 rounded-full bg-affordance-disabled" />
    </div>
  );
}

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
        {status && status !== "Saved" && status !== "Moved to Trash" ? (
          status
        ) : (
          <>
            {status || "Saved"} <NoteTime note={note} />
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

export function NoteAuthor({
  name,
  picture,
  isAgent,
  avatarOnly = false,
  size = "compact",
}: {
  name: string;
  picture?: string | undefined;
  isAgent: boolean;
  avatarOnly?: boolean;
  size?: ComponentProps<typeof Avatar>["size"];
}) {
  return (
    <span className={styles.byline}>
      <Avatar
        src={picture}
        alt=""
        fallback={name}
        size={size}
        shape={isAgent ? "squircle" : "circle"}
      />
      <span className={avatarOnly ? "sr-only" : undefined}>{name}</span>
    </span>
  );
}
