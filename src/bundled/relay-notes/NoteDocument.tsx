import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SafeMarkdown } from "../../features/messages/SafeMarkdown";
import type { RelaySession } from "../../features/relay/session";
import {
  NoteConflict,
  noteKey,
  noteTag,
  noteUrl,
  parseNoteUrl,
  type Note,
  type NoteAddress,
} from "../../features/notes/model";
import type { NotesWorkspace } from "../../features/notes/workspace";
import { useIdentityNames } from "../../features/identity-names/react";
import { avatarMedia } from "../../shared/avatar-source";
import { writeClipboardText } from "../../shared/clipboard";
import { formatPublicKey } from "../../shared/identity/public-key";
import { readView, subscribeView, writeView } from "../../shared/view-state";
import {
  MAX_MARKDOWN_LENGTH,
  scanMarkdown,
} from "../../features/relay/message-content";
import {
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  ShareIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuNote,
  MenuPopup,
  MenuRoot,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { NoteHistory, NoteHistoryMenu, NoteSharing } from "./NoteDialogs";
import { NoteEditor, type NoteEditorHandle } from "./NoteEditor";
import { NoteSaveAction } from "./NoteSaveAction";
import { NoteByline } from "./NoteMetadata";
import readerStyles from "./NotesPage.module.css";
import styles from "./WorkingNotes.module.css";
import type { DocumentView } from "./working-route";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The page could not be read.";
export type NoteFocus = {
  target: "title" | "body";
  start: number;
  end: number;
  source: boolean;
};

const nothing = () => {};

export function NoteDocument({
  address,
  workspace,
  catalogue = [],
  partial = false,
  onOpen,
  onOpenLink,
  onChange = nothing,
  onDirty = nothing,
  onUnavailable = nothing,
  view,
  onViewChange,
  active = true,
  initialFocus,
  initialAutoSave,
}: {
  address: NoteAddress;
  workspace: NotesWorkspace;
  catalogue?: readonly Note[];
  partial?: boolean;
  onOpen(address: NoteAddress): void;
  onOpenLink?: ((url: string) => boolean) | undefined;
  onChange?(note: Note): void;
  onDirty?(dirty: boolean): void;
  onUnavailable?(address: NoteAddress): void;
  view?: DocumentView | undefined;
  onViewChange?: ((view: DocumentView) => void) | undefined;
  active?: boolean;
  initialFocus?: NoteFocus | undefined;
  initialAutoSave?: boolean | undefined;
}) {
  const cachedDraft = useRef(workspace.drafts.get(noteKey(address))).current;
  const [note, setNote] = useState<Note | undefined>(cachedDraft?.base);
  const [title, setTitle] = useState(cachedDraft?.title ?? "");
  const [markdown, setMarkdown] = useState(cachedDraft?.markdown ?? "");
  const [localEditing, setLocalEditing] = useState(true);
  const [source, setSource] = useState(initialFocus?.source ?? false);
  const titleInput = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef(initialFocus);
  const needsFocus = useRef(true);
  useLayoutEffect(() => {
    if (active) needsFocus.current = true;
  }, [active]);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [composing, setComposing] = useState(false);
  const saveRequest = useRef<AbortController | null>(null);
  const refreshAfterSave = useRef(false);
  const changedAt = useRef<number | undefined>(undefined);
  const autoSaveKey = `note-auto-save:${noteKey(address)}`;
  const [autoSave, setAutoSave] = useState(
    () =>
      readView<unknown>(
        workspace.session.scope,
        autoSaveKey,
        initialAutoSave ?? true,
      ) !== false,
  );
  useEffect(() => {
    const read = () =>
      setAutoSave(
        readView<unknown>(
          workspace.session.scope,
          autoSaveKey,
          initialAutoSave ?? true,
        ) !== false,
      );
    read();
    return subscribeView(workspace.session.scope, read);
  }, [workspace, autoSaveKey, initialAutoSave]);
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
  const [error, setError] = useState(
    initialAutoSave !== undefined &&
      readView(workspace.session.scope, autoSaveKey, undefined) === undefined
      ? "Your auto-save setting could not be remembered on this device."
      : "",
  );
  const [status, setStatus] = useState("");
  const [unavailable, setUnavailable] = useState(!!cachedDraft);
  const [conflict, setConflict] = useState<Note>();
  const [restoreFrom, setRestoreFrom] = useState<Note | undefined>(
    cachedDraft?.restoreFrom,
  );
  const dirty = !!note && (title !== note.title || markdown !== note.markdown);
  const editing =
    (view ? (view.edit ?? true) : localEditing) &&
    ((canEdit && !note?.deleted) || dirty || !!restoreFrom);
  const [localDialog, setLocalDialog] = useState<
    "share" | "history" | "link" | "delete" | undefined
  >();
  const dialog = active ? (view ? view.dialog : localDialog) : undefined;
  useLayoutEffect(() => {
    if (dialog) {
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
  }, [active, busy, unavailable, note, canEdit, editing, dialog]);
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
    setNote(next);
    setTitle(next.title);
    setMarkdown(next.markdown);
    setConflict(undefined);
    setRestoreFrom(undefined);
    setSaveError("");
    callbacks.current.onChange(next);
  }, []);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      // A local revision may echo before its save receipt. Reconcile after the
      // transaction settles so our own write cannot conflict with its draft.
      if (saveRequest.current) {
        refreshAfterSave.current = true;
        return;
      }
      setBusy(true);
      setError("");
      try {
        const current = await workspace.open(address, signal);
        const roles = await workspace.authority(current.channel, signal);
        signal?.throwIfAborted();
        setUnavailable(false);
        setCanEdit(
          ["owner", "admin", "member", "bot"].includes(
            roles.roles[workspace.session.viewer ?? ""] ?? "",
          ) && current.editable,
        );
        const previous = latest.current;
        const unsaved =
          previous.note &&
          (previous.title !== previous.note.title ||
            previous.markdown !== previous.note.markdown ||
            previous.restoreFrom);
        if (unsaved && previous.note?.revision !== current.revision)
          setConflict(current);
        else if (!unsaved) adopt(current);
        callbacks.current.onChange(current);
      } catch (error) {
        if (!signal?.aborted) {
          setError(errorText(error));
          setCanEdit(false);
          setUnavailable(true);
          setDialog(undefined);
          setConflict(undefined);
          callbacks.current.onUnavailable(address);
        }
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [workspace, address, adopt, setDialog],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
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
      if (known) void refresh();
    });
  }, [workspace, address, refresh]);
  const [deletedPreview, setDeletedPreview] = useState<Note>();
  const [previewError, setPreviewError] = useState("");
  const currentRevision = note?.revision;
  useEffect(() => {
    setDeletedPreview(undefined);
    setPreviewError("");
    if (!currentRevision || !note?.deleted || unavailable) return;
    const controller = new AbortController();
    void (async () => {
      try {
        let offset = 0;
        while (true) {
          const page = await workspace.history(
            address,
            offset,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          const revision = page.revisions.find((entry) => !entry.deleted);
          if (revision) {
            setDeletedPreview(revision);
            return;
          }
          if (!page.more) return;
          offset += page.revisions.length;
        }
      } catch (error) {
        if (!controller.signal.aborted) setPreviewError(errorText(error));
      }
    })();
    return () => controller.abort();
  }, [workspace, address, currentRevision, note?.deleted, unavailable]);
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
      workspace.session.subscribeLive(({ events }) => {
        if (
          events.some(
            (event) =>
              event.kind === 45010 &&
              event.id !== currentRevision &&
              noteTag(event, "d") === address.id &&
              noteTag(event, "h") === address.channel,
          )
        )
          void refresh();
      }),
    [workspace, address, currentRevision, refresh],
  );
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (error) {
      if (error instanceof NoteConflict) setConflict(error.current);
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const save = useCallback(
    async (automatic = false, revision?: Note) => {
      const current = latest.current;
      const base = current.note;
      if (
        !base ||
        current.busy ||
        saveRequest.current ||
        !current.canEdit ||
        current.unavailable ||
        current.conflict ||
        (!revision &&
          base.title === current.title &&
          base.markdown === current.markdown &&
          !current.restoreFrom) ||
        (base.deleted && !current.restoreFrom && !revision)
      )
        return;
      const request = new AbortController();
      saveRequest.current = request;
      changedAt.current = undefined;
      const restoration = base.deleted
        ? (revision ?? current.restoreFrom)
        : undefined;
      setSaving(true);
      if (revision) setBusy(true);
      setSaveError("");
      setStatus("");
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
          setStatus("Saved");
          return;
        }
        const unchanged =
          latest.current.title === current.title &&
          latest.current.markdown === current.markdown;
        // Advance the accepted base without replacing edits made in flight.
        latest.current = {
          ...latest.current,
          note: next,
          restoreFrom: undefined,
        };
        setNote(next);
        setRestoreFrom(undefined);
        callbacks.current.onChange(next);
        if (!automatic && unchanged) setEditing(false);
        setStatus("Saved");
      } catch (error) {
        if (request.signal.aborted) return;
        if (error instanceof NoteConflict) setConflict(error.current);
        setSaveError(errorText(error));
      } finally {
        saveRequest.current = null;
        if (!request.signal.aborted) {
          setSaving(false);
          if (revision) setBusy(false);
          if (refreshAfterSave.current) {
            refreshAfterSave.current = false;
            void refresh();
          }
        }
      }
    },
    [workspace, refresh, setEditing, adopt, setDialog],
  );
  useEffect(() => {
    if (
      !autoSave ||
      dialog === "history" ||
      !note ||
      (title === note.title && markdown === note.markdown) ||
      !canEdit ||
      unavailable ||
      note.deleted ||
      restoreFrom ||
      conflict ||
      saveError ||
      composing
    ) {
      changedAt.current = undefined;
      return;
    }
    if (busy || saving) return;
    const started = changedAt.current ?? Date.now();
    changedAt.current = started;
    const timer = window.setTimeout(
      () => void save(true),
      Math.max(0, Math.min(1500, 10_000 - (Date.now() - started))),
    );
    return () => window.clearTimeout(timer);
  }, [
    autoSave,
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
  const backlinks = useMemo(
    () =>
      catalogue.filter(
        (source) =>
          !source.deleted &&
          source.markdown.length <= MAX_MARKDOWN_LENGTH &&
          noteKey(source) !== noteKey(address) &&
          scanMarkdown(source.markdown).links.some((link) => {
            const target =
              typeof link.url === "string" ? parseNoteUrl(link.url) : undefined;
            return (
              target?.community === community &&
              noteKey(target) === noteKey(address)
            );
          }),
      ),
    [catalogue, address, community],
  );
  const exportMarkdown = () => {
    if (!note) return;
    const url = URL.createObjectURL(
      new Blob([editing || dirty ? markdown : note.markdown], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(editing ? title : note.title).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 80) || "page"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyLink = () => {
    void run(async () => {
      await writeClipboardText(noteUrl(address, community));
      setStatus("Page link copied");
    });
  };
  return (
    <article
      className={styles.documentPane}
      aria-label={
        !unavailable && note
          ? (deletedPreview?.title ?? note.title)
          : "Working page"
      }
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: blank-space clicks extend the existing textbox hit area; keyboard users reach that textbox with Tab. */}
      <section
        className={readerStyles.document}
        aria-label="Page contents"
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
            busy ||
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
        {note && canEdit && !unavailable && !note.deleted ? (
          <Field label="Title" labelVisibility="hidden">
            <Input
              ref={titleInput}
              appearance="heading"
              value={title}
              onValueChange={setTitle}
              disabled={busy}
              readOnly={!editing}
              tabIndex={editing ? undefined : -1}
            />
          </Field>
        ) : (
          <h2 className="text-heading">
            {!unavailable && note
              ? (deletedPreview?.title ?? note.title)
              : "Working page"}
          </h2>
        )}
        {note && !unavailable && (
          <NoteByline
            note={note.event}
            status={
              note.deleted
                ? "Deleted"
                : canEdit
                  ? saving || (dirty && autoSave && !saveError && !conflict)
                    ? "Saving…"
                    : saveError
                      ? "Save paused"
                      : dirty
                        ? "Unsaved changes"
                        : status || "Saved"
                  : undefined
            }
            isAgent={!!profile?.isAgent}
            author={authorName}
            picture={avatarMedia(profile?.picture, workspace.session.media)}
          />
        )}
        <div className={styles.actions}>
          {note && canEdit && !note.deleted && (
            <Select
              label="Page mode"
              variant="compact"
              size="sm"
              value={editing ? "editing" : "viewing"}
              disabled={busy || saving}
              groups={[
                {
                  label: "Page mode",
                  options: [
                    { value: "viewing", label: "Viewing" },
                    { value: "editing", label: "Editing" },
                  ],
                },
              ]}
              onValueChange={(mode) => {
                setStatus("");
                setEditing(mode === "editing");
              }}
            />
          )}
          <NoteSaveAction
            shown={
              !!note &&
              !!(dirty || restoreFrom) &&
              (!autoSave || !!saveError || !!restoreFrom)
            }
            loading={saving}
            disabled={busy || !!conflict || !canEdit || unavailable}
            onClick={() => void save()}
          >
            {note?.deleted ? "Restore page" : saveError ? "Retry save" : "Save"}
          </NoteSaveAction>
          {note?.deleted && canEdit && !unavailable && (
            <Button
              variant="prominent"
              size="sm"
              disabled={busy || !!conflict || !deletedPreview?.editable}
              loading={saving}
              onClick={() => void save(false, deletedPreview)}
            >
              Restore
            </Button>
          )}
          <IconButton
            aria-label="Refresh page"
            title="Refresh page"
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
              void refresh();
            }}
          />
          {note && !unavailable && (
            <>
              <IconButton
                ref={shareTrigger}
                aria-label="Share page"
                title="Share page"
                icon={<ShareIcon size={16} />}
                onClick={() => setDialog("share")}
              />
              <MenuRoot>
                <MenuTrigger
                  render={
                    <IconButton
                      ref={actionsTrigger}
                      aria-label="Page actions"
                      title="Page actions"
                      icon={<DotsThreeIcon size={16} />}
                    />
                  }
                />
                <MenuPopup>
                  <MenuItem onClick={copyLink}>Copy page link</MenuItem>
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
                  {!note.deleted && backlinks.length > 0 && (
                    <MenuSubmenu>
                      <MenuSubmenuTrigger>Linked pages</MenuSubmenuTrigger>
                      <MenuSubmenuPopup aria-label="Linked pages">
                        {backlinks.map((source) => (
                          <MenuItem
                            key={noteKey(source)}
                            onClick={() => onOpen(source)}
                          >
                            {source.title}
                          </MenuItem>
                        ))}
                        {partial && (
                          <MenuNote>
                            More pages are available in the browser. Linked
                            pages cover the loaded pages.
                          </MenuNote>
                        )}
                      </MenuSubmenuPopup>
                    </MenuSubmenu>
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
                  >
                    {canEdit && !note.deleted && (
                      <MenuItem
                        onClick={() => {
                          const enabled = !autoSave;
                          setAutoSave(enabled);
                          setSaveError("");
                          if (
                            !writeView(
                              workspace.session.scope,
                              autoSaveKey,
                              enabled,
                            )
                          )
                            setError(
                              "This auto-save setting could not be remembered on this device.",
                            );
                        }}
                      >
                        {autoSave ? "Disable auto-save" : "Enable auto-save"}
                      </MenuItem>
                    )}
                  </NoteHistoryMenu>
                  <MenuItem onClick={exportMarkdown}>Export Markdown</MenuItem>
                  {canEdit && !note.deleted && (
                    <MenuItem
                      disabled={busy || saving || dirty}
                      onClick={() => setDialog("delete")}
                    >
                      Delete page
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
            {autoSave ? "Auto-save is paused." : "Saving failed."} Your draft is
            kept. {saveError}
          </p>
        )}
        {note && !unavailable && !canEdit && !note.deleted && (
          <p className="text-caption text-subtle">
            {note.editable
              ? "You have read access."
              : "This page format is read-only in this version of Buzz."}
          </p>
        )}
        {previewError && <p role="alert">{previewError} Refresh to retry.</p>}
        {note &&
          (editing || (!unavailable && (!note.deleted || deletedPreview))) && (
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
                disabled={busy}
                notes={catalogue}
                community={community}
                linkOpen={dialog === "link"}
                onLinkOpenChange={(open) =>
                  setDialog(open ? "link" : undefined)
                }
                onSave={() => void save()}
              >
                <NoteMarkdown
                  text={
                    note.deleted && !editing
                      ? (deletedPreview?.markdown ?? "")
                      : markdown
                  }
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
            onRestore={(revision) => void save(false, revision)}
          />
        )}
        {note && dialog === "delete" && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setDialog(undefined);
            }}
            title="Delete this page?"
            description="You can restore it from retained history."
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
                  Delete page
                </Button>
              </>
            }
          />
        )}
        {conflict && active && (
          <Dialog
            open
            onOpenChange={() => {}}
            title="This page has a newer revision"
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
                (conflict.deleted ? "The page was deleted." : "Empty page")}
            </pre>
          </Dialog>
        )}
      </section>
      <div
        ref={setToolbarTarget}
        className={styles.editorDock}
        hidden={!editing || source}
      />
    </article>
  );
}

export function NoteMarkdown({
  text,
  community,
  onOpen,
  session,
  openLink,
}: {
  text: string;
  community: string;
  onOpen(address: NoteAddress): void;
  session?: RelaySession | undefined;
  openLink?: ((url: string) => boolean) | undefined;
}) {
  const scanned = useMemo(
    () => (text.length <= MAX_MARKDOWN_LENGTH ? scanMarkdown(text) : undefined),
    [text],
  );
  if (!scanned || scanned.tooDeep)
    return (
      <div className={readerStyles.markdown}>
        <pre>{text}</pre>
      </div>
    );
  return (
    <div className={readerStyles.markdown}>
      <SafeMarkdown
        content={text}
        session={session}
        openLink={(url) => {
          const note = parseNoteUrl(url);
          if (note?.community === community) {
            onOpen(note);
            return true;
          }
          return openLink?.(url) ?? false;
        }}
      />
    </div>
  );
}
