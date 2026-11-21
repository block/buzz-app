import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  NoteConflict,
  noteKey,
  noteTag,
  type Note,
  type NoteAddress,
} from "./model";
import type { NotesWorkspace } from "./workspace";
import { useLiveUpdatesInterrupted } from "./live-updates";
import { useIdentityNames } from "../../features/identity-names/react";
import { isTransientFailure } from "../../features/relay/errors";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  ShareIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { NoteHistory, NoteHistoryMenu, NoteSharing } from "./NoteDialogs";
import { NoteEditor, type NoteEditorHandle } from "./NoteEditor";
import { NoteSaveAction } from "./NoteSaveAction";
import {
  NoteByline,
  NoteBylinePlaceholder,
  noteDisplayTitle,
} from "./NoteMetadata";
import { NoteTitle } from "./NoteTitle";
import readerStyles from "./NotesPage.module.css";
import { NoteMarkdown } from "./NoteMarkdown";
import styles from "./WorkingNotes.module.css";
import type { DocumentView } from "./working-route";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The doc could not be read.";
export type NoteFocus = {
  target: "title" | "body";
  start: number;
  end: number;
  source: boolean;
};

const nothing = () => {};

function hasEdits(base: Note, draft: Pick<Note, "title" | "markdown">) {
  // Saved titles are trimmed. Keep the input intact while comparing with the relay.
  return (
    base.title.trim() !== draft.title.trim() || base.markdown !== draft.markdown
  );
}

export function NoteDocument({
  address,
  workspace,
  onOpen,
  onOpenInDocs,
  onOpenLink,
  onChange = nothing,
  onDirty = nothing,
  onUnavailable = nothing,
  view,
  onViewChange,
  active = true,
  initialFocus,
}: {
  address: NoteAddress;
  workspace: NotesWorkspace;
  onOpen(address: NoteAddress): void;
  onOpenInDocs?: () => void;
  onOpenLink?: ((url: string) => boolean) | undefined;
  onChange?(note: Note): void;
  onDirty?(dirty: boolean): void;
  onUnavailable?(address: NoteAddress): void;
  view?: DocumentView | undefined;
  onViewChange?: ((view: DocumentView) => void) | undefined;
  active?: boolean;
  initialFocus?: NoteFocus | undefined;
}) {
  const cachedDraft = useRef(workspace.drafts.get(noteKey(address))).current;
  const [note, setNote] = useState<Note | undefined>(cachedDraft?.base);
  const [title, setTitle] = useState(cachedDraft?.title ?? "");
  const [markdown, setMarkdown] = useState(cachedDraft?.markdown ?? "");
  const [localEditing, setLocalEditing] = useState(true);
  const [source, setSource] = useState(initialFocus?.source ?? false);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const pendingFocus = useRef(initialFocus);
  const needsFocus = useRef(true);
  useLayoutEffect(() => {
    if (active) needsFocus.current = true;
  }, [active]);
  const [canEdit, setCanEdit] = useState(false);
  const [blocking, setBlocking] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const liveInterrupted = useLiveUpdatesInterrupted(
    workspace.session.live,
    (channel) => channel === address.channel,
  );
  const busy = blocking || refreshing;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [composing, setComposing] = useState(false);
  const saveRequest = useRef<AbortController | null>(null);
  const refreshAfterSave = useRef(false);
  useEffect(() => () => saveRequest.current?.abort(), []);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const [historySelection, setHistorySelection] = useState<{
    revision: string;
    offset: number;
  }>();
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<NoteEditorHandle>(null);
  const blankPress = useRef(false);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(!!cachedDraft);
  const [retained, setRetained] = useState<Note>();
  const [retainedReadFailed, setRetainedReadFailed] = useState(false);
  const [retainedAttempt, setRetainedAttempt] = useState(0);
  const [conflict, setConflict] = useState<Note>();
  const [restoreFrom, setRestoreFrom] = useState<Note | undefined>(
    cachedDraft?.restoreFrom,
  );
  const dirty = !!note && hasEdits(note, { title, markdown });
  const wantsEditing = view ? (view.edit ?? true) : localEditing;
  const editing =
    wantsEditing && ((canEdit && !note?.deleted) || dirty || !!restoreFrom);
  const [localDialog, setLocalDialog] = useState<
    "share" | "history" | "link" | "delete" | undefined
  >();
  const dialog = active ? (view ? view.dialog : localDialog) : undefined;
  useLayoutEffect(() => {
    if (dialog || !wantsEditing) {
      needsFocus.current = false;
      pendingFocus.current = undefined;
      return;
    }
    if (
      !active ||
      busy ||
      unavailable ||
      !note ||
      !canEdit ||
      !editing ||
      !needsFocus.current
    )
      return;
    const focus = pendingFocus.current;
    if (!focus) {
      needsFocus.current = false;
      // Opening focus happens before interaction; preserve a selection already placed.
      if (
        !editor.current?.selection() &&
        document.activeElement !== titleInput.current
      )
        editor.current?.focusEnd();
      return;
    }
    // First-save handoff waits for the shared editor to adopt the saved draft.
    const frame = requestAnimationFrame(() => {
      needsFocus.current = false;
      pendingFocus.current = undefined;
      if (focus.target === "body") editor.current?.focusSelection(focus);
      else {
        const field = titleInput.current;
        field?.focus();
        field?.setSelectionRange(focus.start, focus.end);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, busy, unavailable, note, canEdit, editing, dialog, wantsEditing]);
  const presentation = useRef({ view, onViewChange, editing });
  presentation.current = { view, onViewChange, editing };
  const setEditing = useCallback((edit: boolean) => {
    setLocalEditing(edit);
    const current = presentation.current;
    if (current.editing !== edit)
      current.onViewChange?.({ ...current.view, edit });
  }, []);
  const setDialog = useCallback((next: DocumentView["dialog"]) => {
    setLocalDialog(next);
    const current = presentation.current;
    if (current.view?.dialog !== next)
      current.onViewChange?.({
        edit: current.editing,
        ...(next ? { dialog: next } : {}),
      });
  }, []);
  const latest = useRef({
    note,
    title,
    markdown,
    restoreFrom,
    busy,
    canEdit,
    conflict,
    unavailable,
  });
  latest.current = {
    note,
    title,
    markdown,
    restoreFrom,
    busy,
    canEdit,
    conflict,
    unavailable,
  };
  const callbacks = useRef({ onChange, onDirty, onUnavailable });
  callbacks.current = { onChange, onDirty, onUnavailable };
  const community = workspace.session.scope.replace(/:[0-9a-f]{64}$/, "");
  useEffect(() => {
    const key = noteKey(address);
    if (note && dirty)
      workspace.drafts.set(key, {
        base: note,
        title,
        markdown,
        ...(restoreFrom ? { restoreFrom } : {}),
      });
    else workspace.drafts.delete(key);
  }, [workspace, address, note, dirty, title, markdown, restoreFrom]);
  useEffect(() => {
    callbacks.current.onDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const adopt = useCallback((next: Note) => {
    const previous = latest.current.note;
    setRetained(
      next.deleted &&
        previous &&
        !previous.deleted &&
        previous.revision === noteTag(next.event, "prev")
        ? previous
        : undefined,
    );
    setNote(next);
    setTitle(next.title);
    setMarkdown(next.markdown);
    setConflict(undefined);
    setRestoreFrom(undefined);
    setSaveError("");
    callbacks.current.onChange(next);
  }, []);
  const refresh = useCallback(
    async ({
      signal,
      background,
      revoked,
    }: {
      signal?: AbortSignal;
      background?: boolean;
      revoked?: boolean;
    } = {}) => {
      // A local revision may echo before its save receipt. Reconcile after the
      // transaction settles so our own write cannot conflict with its draft.
      if (saveRequest.current) {
        refreshAfterSave.current = true;
        return;
      }
      // Keep an open editor interactive during passive relay reconciliation.
      const setPending = background ? setRefreshing : setBlocking;
      setPending(true);
      setError("");
      try {
        const current = await workspace.open(address, signal);
        const roles = await workspace.authority(current.channel, signal);
        signal?.throwIfAborted();
        setNeedsRefresh(false);
        setUnavailable(false);
        setCanEdit(
          ["owner", "admin", "member", "bot"].includes(
            roles.roles[workspace.session.viewer ?? ""] ?? "",
          ) && current.editable,
        );
        const previous = latest.current;
        if (previous.note?.revision !== current.revision) {
          if (
            previous.note &&
            (hasEdits(previous.note, previous) || previous.restoreFrom)
          )
            setConflict(current);
          else adopt(current);
        }
        callbacks.current.onChange(current);
      } catch (error) {
        if (!signal?.aborted) {
          setNeedsRefresh(true);
          if (
            !revoked &&
            latest.current.note &&
            !latest.current.unavailable &&
            isTransientFailure(error)
          )
            return;
          setError(errorText(error));
          setCanEdit(false);
          setUnavailable(true);
          setDialog(undefined);
          setConflict(undefined);
          callbacks.current.onUnavailable(address);
        }
      } finally {
        if (!signal?.aborted) setPending(false);
      }
    },
    [workspace, address, adopt, setDialog],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh({ signal: controller.signal });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const roster = () =>
      workspace.session.channels.get?.(address.channel)?.members?.join(":");
    let prior = roster();
    return workspace.session.channels.subscribeList(() => {
      const next = roster();
      if (next === prior) return;
      const known = prior !== undefined;
      prior = next;
      if (known) void refresh({ background: true });
    });
  }, [workspace, address, refresh]);
  const deletedParent =
    !unavailable && note?.deleted ? noteTag(note.event, "prev") : undefined;
  const retainedVersion =
    deletedParent && retained?.revision === deletedParent
      ? retained
      : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly retries the restore-source read.
  useEffect(() => {
    setRetainedReadFailed(false);
    if (!deletedParent || retainedVersion) return;
    const controller = new AbortController();
    void workspace
      .history(address, 0, controller.signal)
      .then(({ revisions }) => {
        controller.signal.throwIfAborted();
        setRetained(
          revisions.find(
            (revision) =>
              revision.revision === deletedParent && !revision.deleted,
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setRetainedReadFailed(true);
      });
    return () => controller.abort();
  }, [workspace, address, deletedParent, retainedVersion, retainedAttempt]);
  const profiles = useSyncExternalStore(
    workspace.session.profiles.subscribe,
    workspace.session.profiles.snapshot,
  );
  const resolveName = useIdentityNames(workspace.session.names);
  const author = note?.event.pubkey ?? "";
  const profile = profiles.get(author);
  const authorName =
    author === workspace.session.viewer
      ? "You"
      : resolveName(author, profile?.name ?? formatPublicKey(author) ?? author);
  useEffect(
    () =>
      workspace.session.artifacts.follow(
        [address.channel],
        (events) => {
          if (
            events.some(
              (event) =>
                event.kind !== 45010 ||
                (event.id !== latest.current.note?.revision &&
                  noteTag(event, "d") === address.id &&
                  noteTag(event, "h") === address.channel),
            )
          )
            void refresh({ background: true });
        },
        () => {
          callbacks.current.onUnavailable(address);
          void refresh({ background: true, revoked: true });
        },
      ),
    [workspace, address, refresh],
  );
  const run = async (action: () => Promise<void>) => {
    setBlocking(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (error instanceof NoteConflict) setConflict(error.current);
      setError(errorText(error));
    } finally {
      setBlocking(false);
    }
  };
  const save = useCallback(
    async (revision?: Note) => {
      const current = latest.current;
      const base = current.note;
      if (
        !base ||
        current.busy ||
        saveRequest.current ||
        !current.canEdit ||
        current.unavailable ||
        current.conflict ||
        (!revision && !hasEdits(base, current) && !current.restoreFrom) ||
        (base.deleted && !current.restoreFrom && !revision)
      )
        return;
      const request = new AbortController();
      saveRequest.current = request;
      const restoration = base.deleted
        ? (revision ?? current.restoreFrom)
        : undefined;
      setSaving(true);
      if (revision) setBlocking(true);
      setSaveError("");
      try {
        const next = await workspace.save(
          base,
          {
            title: revision?.title ?? current.title,
            markdown: revision?.markdown ?? current.markdown,
            ...(restoration ? { restoreFrom: restoration } : {}),
          },
          base.deleted ? "restore" : "update",
          request.signal,
        );
        request.signal.throwIfAborted();
        if (revision) {
          latest.current = {
            ...latest.current,
            note: next,
            title: next.title,
            markdown: next.markdown,
            restoreFrom: undefined,
          };
          adopt(next);
          setDialog(undefined);
          return;
        }
        // Advance the accepted base without replacing edits made in flight.
        latest.current = {
          ...latest.current,
          note: next,
          restoreFrom: undefined,
        };
        setNote(next);
        setRestoreFrom(undefined);
        callbacks.current.onChange(next);
      } catch (error) {
        if (request.signal.aborted) return;
        if (error instanceof NoteConflict) setConflict(error.current);
        setSaveError(errorText(error));
      } finally {
        saveRequest.current = null;
        if (!request.signal.aborted) {
          setSaving(false);
          if (revision) setBlocking(false);
          if (refreshAfterSave.current) {
            refreshAfterSave.current = false;
            void refresh({ background: true });
          }
        }
      }
    },
    [workspace, refresh, adopt, setDialog],
  );
  useEffect(() => {
    if (
      dialog === "history" ||
      !note ||
      !hasEdits(note, { title, markdown }) ||
      !canEdit ||
      unavailable ||
      note.deleted ||
      restoreFrom ||
      conflict ||
      saveError ||
      composing ||
      busy ||
      saving
    )
      return;
    const timer = window.setTimeout(() => void save(), 1500);
    return () => window.clearTimeout(timer);
  }, [
    dialog,
    canEdit,
    unavailable,
    note,
    restoreFrom,
    conflict,
    saveError,
    composing,
    busy,
    saving,
    title,
    markdown,
    save,
  ]);
  const loading = busy && (!note || unavailable);
  const displayTitle = note && noteDisplayTitle(note, retainedVersion?.title);
  const showRefresh =
    needsRefresh ||
    retainedReadFailed ||
    (!!note && !unavailable && liveInterrupted);
  const shareButton = (
    <IconButton
      ref={shareTrigger}
      aria-label="Share doc"
      title="Share doc"
      icon={<ShareIcon size={16} />}
      disabled={loading}
      onClick={() => setDialog("share")}
    />
  );
  const actionsButton = (
    <IconButton
      ref={actionsTrigger}
      aria-label="Doc actions"
      title="Doc actions"
      icon={<DotsThreeIcon size={16} />}
      disabled={loading}
    />
  );
  return (
    <article
      className={styles.documentPane}
      aria-label={
        !unavailable && note ? displayTitle : loading ? "Loading doc" : "Doc"
      }
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: blank-space clicks extend the existing textbox hit area; keyboard users reach that textbox with Tab. */}
      <section
        className={readerStyles.document}
        aria-label="Doc contents"
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onPointerDown={(event) => {
          blankPress.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          const startedOnBlank = blankPress.current;
          blankPress.current = false;
          if (
            !startedOnBlank ||
            !editing ||
            !canEdit ||
            blocking ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey ||
            event.target !== event.currentTarget ||
            !body.current ||
            event.clientY < body.current.getBoundingClientRect().bottom
          )
            return;
          editor.current?.focusEnd();
        }}
      >
        {loading ? (
          <LoadingRegion
            pending
            label="Loading doc…"
            statusVisibility="screen-reader"
          >
            <div className={readerStyles.loadingHeader}>
              <div
                className={`${readerStyles.loadingTitle} text-heading`}
                aria-hidden="true"
              >
                <span className="h-3 w-1/2 rounded-full bg-affordance-disabled" />
              </div>
              <NoteBylinePlaceholder />
            </div>
          </LoadingRegion>
        ) : note && canEdit && !unavailable && !note.deleted ? (
          <NoteTitle
            ref={titleInput}
            value={title}
            onValueChange={setTitle}
            disabled={blocking}
            readOnly={!editing}
          />
        ) : (
          <h2 className="text-heading">
            {!unavailable && note ? displayTitle : "Doc"}
          </h2>
        )}
        {note && !unavailable && (
          <NoteByline
            note={note.event}
            status={
              note.deleted
                ? "Moved to Trash"
                : canEdit
                  ? saving
                    ? "Saving…"
                    : saveError
                      ? "Save paused"
                      : dirty
                        ? "Unsaved changes"
                        : "Saved"
                  : undefined
            }
            isAgent={!!profile?.isAgent}
            author={authorName}
            picture={avatarMedia(profile?.picture, workspace.session.media)}
          />
        )}
        <div className={styles.actions}>
          {(loading || (note && canEdit && !note.deleted)) && (
            <div className="min-w-20">
              <Select
                label="Doc mode"
                variant="compact"
                appearance={!loading && editing ? "subtle" : "outlined"}
                size="sm"
                value={loading ? "" : editing ? "editing" : "viewing"}
                disabled={loading || busy || saving}
                groups={[
                  {
                    label: "Doc mode",
                    options: [
                      { value: "viewing", label: "Viewing" },
                      { value: "editing", label: "Editing" },
                    ],
                  },
                ]}
                onValueChange={(mode) => setEditing(mode === "editing")}
              />
            </div>
          )}
          <NoteSaveAction
            shown={!!note && ((dirty && !!saveError) || !!restoreFrom)}
            loading={saving}
            disabled={busy || !!conflict || !canEdit || unavailable}
            onClick={() => void save()}
          >
            {restoreFrom ? "Restore doc" : "Retry save"}
          </NoteSaveAction>
          {note?.deleted && canEdit && !unavailable && (
            <Button
              variant="prominent"
              size="sm"
              disabled={busy || !!conflict || !retainedVersion?.editable}
              loading={saving}
              onClick={() => void save(retainedVersion)}
            >
              Restore
            </Button>
          )}
          {showRefresh && (
            <IconButton
              aria-label="Refresh doc"
              title="Refresh doc"
              icon={
                <ArrowsClockwiseIcon
                  size={16}
                  aria-hidden="true"
                  className={busy ? "motion-safe:animate-spin" : undefined}
                />
              }
              aria-busy={busy}
              disabled={busy || saving}
              onClick={() => {
                void refresh({ background: !!note && !unavailable });
                if (retainedReadFailed)
                  setRetainedAttempt((attempt) => attempt + 1);
              }}
            />
          )}
          {loading && (
            <>
              {shareButton}
              {actionsButton}
            </>
          )}
          {note && !unavailable && (
            <>
              {shareButton}
              <MenuRoot>
                <MenuTrigger render={actionsButton} />
                <MenuPopup>
                  {onOpenInDocs && (
                    <MenuItem onClick={onOpenInDocs}>Open in Docs</MenuItem>
                  )}
                  {canEdit && !note.deleted && (
                    <MenuItem
                      disabled={busy}
                      onClick={() => {
                        setSource(editing ? !source : true);
                        setEditing(true);
                      }}
                    >
                      {editing && source ? "Formatted text" : "Markdown source"}
                    </MenuItem>
                  )}
                  <NoteHistoryMenu
                    note={note}
                    workspace={workspace}
                    disabled={busy || saving}
                    onSelect={(revision, offset) => {
                      setHistorySelection({ revision, offset });
                      setLocalDialog("history");
                      presentation.current.onViewChange?.({
                        edit: editing,
                        dialog: "history",
                        revision,
                        offset,
                      });
                    }}
                  />
                  {canEdit && !note.deleted && (
                    <MenuItem
                      tone="danger"
                      disabled={busy || saving || dirty}
                      onClick={() => setDialog("delete")}
                    >
                      Move to Trash
                    </MenuItem>
                  )}
                </MenuPopup>
              </MenuRoot>
            </>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        {saveError && (
          <p role="alert">
            Auto-save is paused. Your draft is kept. {saveError}
          </p>
        )}
        {note && !unavailable && !canEdit && !note.deleted && (
          <p className="text-caption text-subtle">
            {note.editable
              ? "You have read access."
              : "This doc format is read-only in this version of Buzz."}
          </p>
        )}
        {note?.deleted && !unavailable && (
          <p className="text-body-sm text-subtle">This doc is in Trash.</p>
        )}
        {note && !note.deleted && (editing || !unavailable) && (
          <div
            ref={body}
            className={source && editing ? styles.sourceBody : styles.stack}
          >
            <NoteEditor
              ref={editor}
              source={source}
              onSourceChange={setSource}
              toolbarTarget={toolbarTarget}
              value={markdown}
              editing={editing}
              onChange={setMarkdown}
              disabled={blocking}
              linkOpen={dialog === "link"}
              onLinkOpenChange={(open) => setDialog(open ? "link" : undefined)}
              onSave={() => {
                if (saveError || restoreFrom) void save();
              }}
            >
              <NoteMarkdown
                text={markdown}
                community={community}
                onOpen={onOpen}
                session={workspace.session}
                openLink={onOpenLink}
              />
            </NoteEditor>
          </div>
        )}
        {note && dialog === "share" && (
          <NoteSharing
            note={note}
            workspace={workspace}
            trigger={shareTrigger}
            onClose={() => setDialog(undefined)}
          />
        )}
        {note && dialog === "history" && (
          <NoteHistory
            note={note}
            workspace={workspace}
            canEdit={canEdit && !conflict && !unavailable}
            dirty={dirty || !!restoreFrom}
            pending={busy || saving}
            error={saveError}
            trigger={actionsTrigger}
            selection={view ?? historySelection ?? {}}
            onClose={() => setDialog(undefined)}
            onRestore={(revision) => void save(revision)}
          />
        )}
        {note && dialog === "delete" && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setDialog(undefined);
            }}
            title="Move this doc to Trash?"
            description="You can restore it later."
            preventClose={busy}
            actions={
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDialog(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      adopt(
                        await workspace.save(
                          note,
                          { title: note.title, markdown: "" },
                          "delete",
                        ),
                      );
                      setDialog(undefined);
                    });
                  }}
                >
                  Move to Trash
                </Button>
              </>
            }
          />
        )}
        {conflict && active && (
          <Dialog
            open
            onOpenChange={() => {}}
            title="This doc has a newer revision"
            description="Compare the latest contents with your unsaved draft before choosing what to keep."
            size="wide"
            preventClose
            actions={
              <>
                <Button
                  onClick={() => {
                    adopt(conflict);
                    setEditing(false);
                    setError("");
                  }}
                >
                  Use latest version
                </Button>
                <Button
                  disabled={conflict.deleted || !conflict.editable}
                  onClick={() => {
                    setNote(conflict);
                    setConflict(undefined);
                    setError("");
                    setSaveError("");
                  }}
                >
                  I’ve compared; keep my draft
                </Button>
              </>
            }
          >
            <h2 className="text-label">{conflict.title}</h2>
            <pre className={styles.source}>
              {conflict.markdown ||
                (conflict.deleted ? "This doc is in Trash." : "Empty doc")}
            </pre>
          </Dialog>
        )}
      </section>
      <div ref={setToolbarTarget} className={styles.editorDock} />
    </article>
  );
}
