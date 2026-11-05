import type { EventData, ReadFilter } from "../relay/events";
import { relayOrigin } from "../communities/destination";

export const NOTE_KIND = 45010;
export const NOTE_TYPE = "buzz.note";
export const NOTE_LABEL = "buzz.notes";
// Recognize this retired policy label in older note storage; it grants no access.
export const AGENTS_LABEL = "buzz.notes.agents";
export const NOTE_PAGE = 100;
export const MAX_NOTE_BYTES = 32_768;
export const UUID =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const PUBKEY = /^[0-9a-f]{64}$/;
const envelope = new Set([
  "ar",
  "d",
  "h",
  "type",
  "title",
  "op",
  "root",
  "prev",
  "note",
  "auth",
  "ms",
]);
const bytes = (text: string) => new TextEncoder().encode(text).length;

export type NoteEvent = Pick<
  EventData,
  "id" | "pubkey" | "created_at" | "kind" | "content"
> & {
  readonly tags: readonly (readonly string[])[];
};
export type NoteAddress = Readonly<{ id: string; channel: string }>;
export type Note = NoteAddress &
  Readonly<{
    revision: string;
    title: string;
    markdown: string;
    deleted: boolean;
    editable: boolean;
    event: NoteEvent;
  }>;
export type NoteDraft = Readonly<{
  title: string;
  markdown: string;
  restoreFrom?: Note;
}>;
export type NoteTemplate = Readonly<{
  kind: number;
  content: string;
  tags: readonly (readonly string[])[];
}>;
export type NoteRead = (
  filters: readonly ReadFilter[],
  signal?: AbortSignal,
) => Promise<readonly NoteEvent[]>;
export type NotePublish = (
  template: NoteTemplate,
  signal?: AbortSignal,
) => Promise<NoteEvent>;

/** Singleton envelope tags are exact: malformed records never become editable. */
export function noteTag(event: NoteEvent, name: string) {
  const values = event.tags.filter(([key]) => key === name);
  return values.length === 1 && values[0]?.length === 2
    ? values[0][1]
    : undefined;
}
export function noteAddress(value: unknown): NoteAddress {
  const address = value as Partial<NoteAddress> | null;
  if (
    !address ||
    typeof address.id !== "string" ||
    !UUID.test(address.id) ||
    typeof address.channel !== "string" ||
    !UUID.test(address.channel)
  )
    throw new Error("Invalid page address.");
  return { id: address.id, channel: address.channel };
}
/** Storage convention only; callers establish signed membership independently. */
export function independentNoteStorage(
  address: NoteAddress,
  metadata: NoteEvent | undefined,
) {
  if (metadata?.kind !== 39000 || noteTag(metadata, "d") !== address.channel)
    return false;
  const labels = metadata.tags
    .filter(([key]) => key === "t")
    .map(([, value]) => value);
  const visibility = metadata.tags.filter(
    ([key]) => key === "public" || key === "private",
  );
  const admissions = metadata.tags.filter(([key]) => key === "join_role");
  return (
    labels[0] === "system" &&
    visibility.length === 1 &&
    visibility[0]?.length === 1 &&
    (visibility[0]?.[0] === "private" ||
      (visibility[0]?.[0] === "public" &&
        admissions.length === 1 &&
        admissions[0]?.length === 2 &&
        admissions[0]?.[1] === "guest")) &&
    labels.includes(NOTE_LABEL) &&
    labels.includes(`${NOTE_LABEL}.${address.id}`) &&
    labels.filter(
      (label) => label?.startsWith(`${NOTE_LABEL}.`) && label !== AGENTS_LABEL,
    ).length === 1
  );
}
export function parseNote(event: NoteEvent): Note | undefined {
  const id = noteTag(event, "d"),
    channel = noteTag(event, "h");
  if (
    event.kind !== NOTE_KIND ||
    noteTag(event, "ar") !== "1" ||
    noteTag(event, "type") !== NOTE_TYPE ||
    !id ||
    !UUID.test(id) ||
    !channel ||
    !UUID.test(channel)
  )
    return;
  const op = noteTag(event, "op");
  if (!["create", "update", "move", "delete", "restore"].includes(op ?? ""))
    return;
  if (
    (op !== "create" && !PUBKEY.test(noteTag(event, "prev") ?? "")) ||
    (event.tags.some(([key]) => key === "root") &&
      !PUBKEY.test(noteTag(event, "root") ?? ""))
  )
    return;
  const deleted = op === "delete";
  const title = noteTag(event, "title");
  if (
    (!deleted && (!title?.trim() || bytes(title) > 512)) ||
    (deleted && event.content !== "")
  )
    return;
  return {
    id,
    channel,
    revision: event.id,
    title: deleted ? "Deleted page" : (title ?? ""),
    markdown: event.content,
    deleted,
    editable:
      deleted ||
      (noteTag(event, "note") === "1" &&
        bytes(event.content) <= MAX_NOTE_BYTES),
    event,
  };
}
export function validateDraft(draft: NoteDraft) {
  if (!draft.title.trim() || bytes(draft.title) > 512)
    throw new Error("Give the page a title of at most 512 bytes.");
  if (bytes(draft.markdown) > MAX_NOTE_BYTES)
    throw new Error("Keep this page under 32 KiB of Markdown.");
}
export function noteTemplate(
  address: NoteAddress,
  draft: NoteDraft,
  previous?: Note,
  operation: "create" | "update" | "delete" | "restore" = previous
    ? "update"
    : "create",
): NoteTemplate {
  noteAddress(address);
  if (operation !== "delete") validateDraft(draft);
  if (
    (operation === "create") === !!previous ||
    (previous &&
      (previous.id !== address.id || previous.channel !== address.channel))
  )
    throw new Error("The page revision does not match this page.");
  if (previous && !previous.editable)
    throw new Error("This page uses an unsupported page format.");
  const source = draft.restoreFrom;
  if (
    source &&
    (operation !== "restore" ||
      source.id !== address.id ||
      source.channel !== address.channel ||
      !source.editable ||
      source.deleted)
  )
    throw new Error("Choose a supported revision of this page to restore.");
  const extra =
    operation === "delete"
      ? []
      : (source?.event.tags ?? previous?.event.tags ?? [])
          .filter(([key]) => key && !envelope.has(key))
          .map((tag) => [...tag]);
  // A root anchors a conversation; only prev links artifact revisions.
  const root = previous ? noteTag(previous.event, "root") : undefined;
  const tags = [
    ["ar", "1"],
    ["d", address.id],
    ["h", address.channel],
    ["type", NOTE_TYPE],
    ["op", operation],
    ...(previous
      ? [...(root ? [["root", root]] : []), ["prev", previous.revision]]
      : []),
    ...(operation === "delete"
      ? []
      : [["title", draft.title.trim()], ["note", "1"], ...extra]),
  ];
  // Leave room for host-supplied attestation and the complete 64 KiB frame.
  const template = {
    kind: NOTE_KIND,
    content: operation === "delete" ? "" : draft.markdown,
    tags,
  };
  if (tags.length > 250 || bytes(JSON.stringify(template)) > 60_000)
    throw new Error("This page and its metadata exceed the save limit.");
  return template;
}

/** The current projection is relay-owned; never choose the newest timestamp locally. */
export async function readNote(
  read: NoteRead,
  address: NoteAddress,
  signal?: AbortSignal,
) {
  noteAddress(address);
  // A named d lookup includes the deletion head; current-list mode omits it.
  const events = await read(
    [
      {
        kinds: [NOTE_KIND],
        "#h": [address.channel],
        "#d": [address.id],
        limit: 1,
        consistency: "strong",
      },
    ],
    signal,
  );
  signal?.throwIfAborted();
  const [event] = events;
  if (events.length !== 1 || !event)
    throw new Error("This page is unavailable or you no longer have access.");
  const note = parseNote(event);
  if (!note || note.id !== address.id || note.channel !== address.channel)
    throw new Error("The relay returned an unsupported page.");
  return note;
}
export class NoteConflict extends Error {
  constructor(readonly current: Note) {
    super(
      "This page changed since you opened it. Your draft is kept; compare it with the latest revision before saving again.",
    );
  }
}
export async function saveNote(
  read: NoteRead,
  publish: NotePublish,
  base: Note,
  draft: NoteDraft,
  operation: "update" | "delete" | "restore" = "update",
  signal?: AbortSignal,
) {
  const current = await readNote(read, base, signal);
  if (current.revision !== base.revision) throw new NoteConflict(current);
  if (
    (operation === "update" && base.deleted) ||
    (operation === "restore" && !base.deleted)
  )
    throw new Error("Refresh the page before changing its deletion state.");
  let saved: NoteEvent;
  try {
    saved = await publish(noteTemplate(base, draft, base, operation), signal);
  } catch (error) {
    if (error instanceof Error && /\bconflict:/.test(error.message)) {
      const latest = await readNote(read, base, signal);
      if (latest.revision !== base.revision) throw new NoteConflict(latest);
    }
    throw error;
  }
  const accepted = await readNote(read, base, signal);
  if (accepted.revision !== saved.id) throw new NoteConflict(accepted);
  return accepted;
}
export function noteUrl(address: NoteAddress, community: string) {
  noteAddress(address);
  const url = new URL("buzz://page");
  url.searchParams.set("community", relayOrigin(community));
  url.searchParams.set("channel", address.channel);
  url.searchParams.set("id", address.id);
  return url.href;
}
export function parseNoteUrl(
  value: string,
): (NoteAddress & { community: string }) | undefined {
  try {
    const url = new URL(value);
    if (
      !/^buzz:\/\/(?:page|document|note)\/?\?/i.test(value) ||
      url.username ||
      url.password ||
      url.port ||
      url.protocol !== "buzz:" ||
      !["page", "document", "note"].includes(url.hostname) ||
      (url.pathname && url.pathname !== "/") ||
      url.hash ||
      [...url.searchParams.keys()].sort().join() !== "channel,community,id"
    )
      return;
    const community = url.searchParams.get("community") ?? "";
    return {
      ...noteAddress({
        id: url.searchParams.get("id"),
        channel: url.searchParams.get("channel"),
      }),
      community: relayOrigin(community),
    };
  } catch {
    return;
  }
}
export const noteKey = (address: NoteAddress) =>
  `${address.channel}:${address.id}`;
export const noteMarkdownLink = (note: Note, community: string) =>
  `[${note.title.replace(/[\\[\]]/g, "\\$&")}](<${noteUrl(note, community)}>)`;

export async function readNoteHistory(
  read: NoteRead,
  address: NoteAddress,
  offset = 0,
  signal?: AbortSignal,
) {
  noteAddress(address);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000)
    throw new Error("History page is out of range.");
  const events = await read(
    [
      {
        kinds: [NOTE_KIND],
        artifact: "history",
        "#h": [address.channel],
        "#d": [address.id],
        limit: NOTE_PAGE,
        offset,
      },
    ],
    signal,
  );
  const notes = events.map(parseNote);
  if (
    notes.some(
      (note) =>
        !note || note.id !== address.id || note.channel !== address.channel,
    )
  )
    throw new Error("History contains an unsupported revision.");
  return {
    revisions: notes as Note[],
    more: events.length === NOTE_PAGE && offset < 10_000,
    limited: events.length === NOTE_PAGE && offset === 10_000,
  };
}
