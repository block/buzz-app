import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isTransientFailure, readErrorKind } from "../../features/relay/errors";
import { retryRead } from "../../features/relay/read-retry";
import {
  NOTE_KIND,
  NOTE_PAGE,
  noteKey,
  noteTag,
  parseNote,
  type Note,
} from "./model";
import type { NotesPage, NotesWorkspace } from "./workspace";
import { useLiveUpdatesInterrupted } from "./live-updates";

function cancelledRead(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    readErrorKind(error) === "cancelled"
  );
}

/** The Docs browser retains only the loaded, currently readable catalogue. */
export function useNotesCollection(workspace: NotesWorkspace) {
  const current = useRef<NotesPage>({ notes: [], more: false });
  const [collection, publish] = useState(current.current);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const liveInterrupted = useLiveUpdatesInterrupted(
    workspace.session.live,
    (channel) => collection.notes.some((note) => note.channel === channel),
  );
  const listing = useRef<AbortController | undefined>(undefined);
  const reading = useRef(new Map<string, AbortController>());
  const revoked = useRef(new Set<string>());
  const setCollection = useCallback(
    (change: (page: NotesPage) => NotesPage) => {
      current.current = change(current.current);
      publish(current.current);
    },
    [],
  );
  const cancelLoad = useCallback(() => {
    listing.current?.abort();
    setLoading(false);
  }, []);
  const remove = useCallback(
    (channels: readonly string[]) => {
      if (current.current.notes.some((note) => channels.includes(note.channel)))
        cancelLoad();
      for (const channel of channels) {
        revoked.current.add(channel);
        reading.current.get(channel)?.abort();
      }
      setCollection((old) => ({
        ...old,
        notes: old.notes.filter((note) => !channels.includes(note.channel)),
      }));
    },
    [cancelLoad, setCollection],
  );
  const changed = useCallback(
    (note: Note) => {
      if (revoked.current.has(note.channel)) return;
      const previous = current.current.notes.find(
        (item) => noteKey(item) === noteKey(note),
      );
      if (previous?.revision === note.revision) return;
      reading.current.get(note.channel)?.abort();
      if (previous) cancelLoad();
      setCollection((old) => ({
        ...old,
        notes: [
          note,
          ...old.notes.filter((item) => noteKey(item) !== noteKey(note)),
        ],
      }));
    },
    [cancelLoad, setCollection],
  );
  const load = useCallback(
    async (more = false) => {
      listing.current?.abort();
      if (!more) {
        for (const request of reading.current.values()) request.abort();
        reading.current.clear();
      }
      const controller = new AbortController();
      listing.current = controller;
      setLoading(true);
      setError("");
      try {
        const page = await retryRead(
          async (signal) => {
            const result = await workspace.list(
              more ? current.current.cursor : undefined,
              signal,
            );
            // Discovery does not populate hidden-channel routes. Resolve this
            // page in one batch before retaining or following any content.
            const ids = [...new Set(result.notes.map((note) => note.channel))];
            if (ids.length)
              await workspace.session.channels.resolve?.(ids, {
                signal,
                consistency: "strong",
              });
            return result;
          },
          controller.signal,
          // Rosters and reconnects can retire a read while this view is still active.
          cancelledRead,
        );
        controller.signal.throwIfAborted();
        page.notes = page.notes.filter(
          (note) => !!workspace.session.channels.get?.(note.channel),
        );
        for (const note of page.notes) revoked.current.delete(note.channel);
        if (!more) setNeedsRefresh(false);
        setCollection((old) => ({
          ...page,
          notes: more
            ? [
                ...new Map(
                  [...old.notes, ...page.notes].map((note) => [
                    noteKey(note),
                    note,
                  ]),
                ).values(),
              ]
            : page.notes,
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!more && current.current.notes.length && isTransientFailure(error))
          setNeedsRefresh(true);
        else
          setError(
            cancelledRead(error)
              ? "Loading docs was interrupted."
              : error instanceof Error
                ? error.message
                : "Docs could not be read.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [workspace, setCollection],
  );
  useEffect(() => {
    void load();
    const requests = reading.current;
    return () => {
      listing.current?.abort();
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, [load]);
  const channels = [...new Set(collection.notes.map((note) => note.channel))]
    .sort()
    .join(":");
  useLayoutEffect(() => {
    if (!channels) return;
    const requests = reading.current;
    const stop = workspace.session.artifacts.follow(
      channels.split(":"),
      (events) => {
        const affected = new Set(
          events
            .filter(
              (event) =>
                event.kind !== 45010 ||
                !current.current.notes.some(
                  (note) => note.revision === event.id,
                ),
            )
            .map((event) => noteTag(event, event.kind === 45010 ? "h" : "d")),
        );
        for (const note of current.current.notes) {
          if (!affected.has(note.channel) || revoked.current.has(note.channel))
            continue;
          cancelLoad();
          requests.get(note.channel)?.abort();
          const controller = new AbortController();
          requests.set(note.channel, controller);
          void workspace
            .open(note, controller.signal)
            .then((head) => {
              controller.signal.throwIfAborted();
              requests.delete(note.channel);
              if (
                current.current.notes.some(
                  (item) => noteKey(item) === noteKey(head),
                )
              )
                changed(head);
            })
            .catch((error: unknown) => {
              if (controller.signal.aborted) return;
              requests.delete(note.channel);
              if (
                isTransientFailure(error) &&
                workspace.session.channels.get?.(note.channel)
              )
                setNeedsRefresh(true);
              else remove([note.channel]);
            });
        }
      },
      remove,
    );
    // Revocation may precede this subscription; follow reports future losses.
    const denied = channels
      .split(":")
      .filter((channel) => !workspace.session.channels.get?.(channel));
    if (denied.length) remove(denied);
    return stop;
  }, [workspace, channels, cancelLoad, changed, remove]);
  const showRefresh =
    !error &&
    (needsRefresh ||
      (liveInterrupted && (!loading || collection.notes.length > 0)));
  return { collection, loading, error, showRefresh, load, changed, remove };
}

/** Resolve retained titles only when browsing Trash, in batches of exact revision IDs. */
export function useTrashTitles(
  workspace: NotesWorkspace,
  entries: readonly Note[],
  enabled: boolean,
) {
  const [titles, setTitles] = useState(
    () => new Map<string, string | undefined>(),
  );
  useEffect(() => {
    if (!enabled) return;
    const pending = entries.flatMap((note) => {
      const parent =
        note.deleted &&
        !titles.has(note.revision) &&
        noteTag(note.event, "prev");
      return parent ? [{ note, parent }] : [];
    });
    if (!pending.length) return;
    const controller = new AbortController();
    const read = async () => {
      const next = new Map(titles);
      for (let offset = 0; offset < pending.length; offset += NOTE_PAGE) {
        const batch = pending.slice(offset, offset + NOTE_PAGE);
        const events = await workspace.read(
          [
            {
              kinds: [NOTE_KIND],
              ids: batch.map(({ parent }) => parent),
              "#h": batch.map(({ note }) => note.channel),
              limit: batch.length,
            },
          ],
          controller.signal,
        );
        const byId = new Map(events.map((event) => [event.id, event]));
        for (const { note, parent } of batch) {
          const event = byId.get(parent);
          const retained = event && parseNote(event);
          next.set(
            note.revision,
            retained && !retained.deleted && noteKey(retained) === noteKey(note)
              ? retained.title
              : undefined,
          );
        }
      }
      controller.signal.throwIfAborted();
      setTitles(next);
    };
    void read().catch(() => {});
    return () => controller.abort();
  }, [enabled, entries, titles, workspace]);
  return titles;
}
