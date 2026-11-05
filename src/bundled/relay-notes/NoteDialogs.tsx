import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { MemberChange } from "../../features/channel-members/administration-protocol";
import { ChannelGeneralAccess } from "../channels/ChannelGeneralAccess";
import { ChannelMembersDialog } from "../channels/ChannelMembersDialog";
import { noteUrl, type Note } from "../../features/notes/model";
import type { NotesWorkspace } from "../../features/notes/workspace";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import {
  MenuItem,
  MenuNote,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
} from "../../shared/design-system/ui/Menu";
import styles from "./WorkingNotes.module.css";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";

export function NoteSharing({
  note,
  workspace,
  onClose,
  trigger,
}: {
  note: Note;
  workspace: NotesWorkspace;
  onClose(): void;
  trigger: RefObject<HTMLElement | null>;
}) {
  const [error, setError] = useState("");
  const [accessChannel, setAccessChannel] = useState<ChannelSummary>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const session = workspace.session;
  const { id, channel } = note;
  const access = useMemo(
    () => workspace.generalAccess({ id, channel }),
    [workspace, id, channel],
  );
  const accessAttempt = useSyncExternalStore(access.subscribe, () =>
    access.snapshot(channel),
  );
  const administration = useSyncExternalStore(
    session.memberAdministration.subscribe,
    () => session.memberAdministration.snapshot(note.channel),
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void (async () => {
      await workspace.resolve({ id, channel }, controller.signal);
      await workspace.sharing(channel, controller.signal);
      controller.signal.throwIfAborted();
      setAccessChannel(session.channels.get?.(channel));
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) setError(message(error));
    });
    return () => controller.abort();
  }, [workspace, session, id, channel]);
  const run = async (
    work?: (signal: AbortSignal) => Promise<unknown>,
    caller?: AbortSignal,
  ) => {
    if (pending.current)
      throw new Error("Wait for the current sharing change to finish.");
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) throw new Error("Reopen sharing to retry.");
    const active = caller ? AbortSignal.any([signal, caller]) : signal;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work?.(active);
      await workspace.sharing(note.channel, active);
      active.throwIfAborted();
      await session.memberAdministration.refresh(note.channel);
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  const roles =
    administration.status === "ready" ? administration.authority : undefined;
  const change = (change: MemberChange, signal: AbortSignal) =>
    run(
      (active) =>
        workspace.setMember(
          note,
          change.pubkey,
          change.role === "guest"
            ? "read"
            : change.role === "member"
              ? "edit"
              : change.role,
          active,
          { expectedRole: change.expectedRole },
        ),
      signal,
    );
  return (
    <ChannelMembersDialog
      session={session}
      channelId={note.channel}
      trigger={trigger}
      close={onClose}
      title="Share access"
      description="Access includes the current page and all retained revisions."
      shareLink={noteUrl(note, session.scope.replace(/:[0-9a-f]{64}$/, ""))}
      memberActions={{
        canAdd: !!roles?.canManage,
        pending: busy || accessAttempt?.status === "saving",
        change,
      }}
      accessSettings={
        <div className={styles.stack}>
          {error && (
            <div className="px-control-inset">
              <p role="alert">{error}</p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  void run().catch((error: unknown) =>
                    setError(message(error)),
                  );
                }}
              >
                Retry page access
              </Button>
            </div>
          )}
          <ChannelGeneralAccess
            capability={access}
            recovery={session.recovery}
            channelId={channel}
            subject="note"
            {...(accessChannel ? { channel: accessChannel } : {})}
          />
        </div>
      }
    />
  );
}

function useRevisions(
  note: Note,
  workspace: NotesWorkspace,
  offset: number,
  enabled = true,
) {
  const [page, setPage] = useState<{
    revisions: Note[];
    more: boolean;
    limited: boolean;
  }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly restarts the read when Retry is requested.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void workspace
      .history(note, offset, controller.signal)
      .then((page) => {
        controller.signal.throwIfAborted();
        setPage(page);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [workspace, note, offset, enabled, attempt]);
  return { page, error, busy, retry: () => setAttempt((value) => value + 1) };
}

export function NoteHistoryMenu({
  note,
  workspace,
  disabled,
  onSelect,
  children,
}: {
  children?: ReactNode;
  note: Note;
  workspace: NotesWorkspace;
  disabled: boolean;
  onSelect(revision: string, offset: number): void;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const { page, error, busy, retry } = useRevisions(
    note,
    workspace,
    offset,
    open,
  );
  return (
    <MenuSubmenu
      onOpenChange={(open) => {
        setOpen(open);
        if (!open) setOffset(0);
      }}
    >
      <MenuSubmenuTrigger disabled={disabled}>
        Revision history
      </MenuSubmenuTrigger>
      <MenuSubmenuPopup aria-label="Revision history">
        {children}
        {children && <MenuSeparator />}
        {busy && <MenuNote role="status">Reading revisions…</MenuNote>}
        {error && (
          <>
            <MenuNote role="alert">{error}</MenuNote>
            <MenuItem closeOnClick={false} onClick={retry}>
              Retry history
            </MenuItem>
          </>
        )}
        {page?.revisions.map((revision) => (
          <MenuItem
            key={revision.revision}
            disabled={busy || !!error}
            onClick={() => onSelect(revision.revision, offset)}
          >
            <span className={styles.revision}>
              <span>{revision.deleted ? "Deleted" : revision.title}</span>
              <span className="text-caption text-subtle">
                {new Date(revision.event.created_at * 1000).toLocaleString()} ·{" "}
                {revision.revision.slice(0, 8)}
                {revision.revision === note.revision ? " · Current" : ""}
              </span>
            </span>
          </MenuItem>
        ))}
        {!busy && page?.revisions.length === 0 && (
          <MenuNote>No retained revisions.</MenuNote>
        )}
        {page?.more && (
          <MenuItem
            disabled={busy}
            closeOnClick={false}
            onClick={() => {
              setOffset(offset + 100);
            }}
          >
            Load older revisions
          </MenuItem>
        )}
        {page?.limited && (
          <MenuNote>
            More retained history exceeds this app’s page limit.
          </MenuNote>
        )}
        {offset > 0 && (
          <MenuItem
            disabled={busy}
            closeOnClick={false}
            onClick={() => {
              setOffset(Math.max(0, offset - 100));
            }}
          >
            Newer revisions
          </MenuItem>
        )}
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}

export function NoteHistory({
  note,
  workspace,
  canEdit,
  dirty,
  pending,
  error: saveError,
  onRestore,
  onClose,
  selection,
  trigger,
}: {
  note: Note;
  workspace: NotesWorkspace;
  canEdit: boolean;
  dirty: boolean;
  pending: boolean;
  error: string;
  onRestore(revision: Note): void;
  onClose(): void;
  selection: { revision?: string; offset?: number };
  trigger: RefObject<HTMLElement | null>;
}) {
  const { page, error, busy, retry } = useRevisions(
    note,
    workspace,
    selection.offset ?? 0,
  );
  const selected = page?.revisions.find(
    (revision) => revision.revision === selection.revision,
  );
  const [confirm, setConfirm] = useState(false);
  const restoreButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Revision preview"
      description="Restoring saves this version as a new latest revision. All history is kept."
      size="wide"
      height="stable"
      preventClose={pending}
      finalFocus={trigger}
      actions={
        canEdit &&
        selected?.editable &&
        !selected.deleted &&
        (selected.revision !== note.revision || dirty) && (
          <Button
            ref={restoreButton}
            disabled={pending || busy || !!error}
            loading={pending}
            onClick={() => {
              if (dirty) setConfirm(true);
              else onRestore(selected);
            }}
          >
            Restore this version
          </Button>
        )
      }
    >
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button onClick={retry}>Retry history</Button>
        </>
      )}
      {saveError && <p role="alert">{saveError}</p>}
      {busy && <p role="status">Reading revision…</p>}
      {selected && (
        <section aria-label="Selected revision" className={styles.stack}>
          <h2 className="text-label">
            {selected.deleted ? "Deleted" : selected.title}
          </h2>
          <p className="text-caption text-subtle">
            {new Date(selected.event.created_at * 1000).toLocaleString()} ·{" "}
            {selected.revision.slice(0, 8)}
          </p>
          <pre className={styles.source}>
            {selected.markdown ||
              (selected.deleted ? "The page was deleted." : "Empty revision")}
          </pre>
        </section>
      )}
      {!busy && !error && !selected && (
        <p>Choose a version from Page actions → Revision history.</p>
      )}
      {confirm && selected && (
        <AlertDialog
          title="Replace unsaved changes?"
          description="Restoring this version replaces your pending edits and saves immediately. All saved revisions are kept."
          finalFocus={restoreButton}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setConfirm(false);
                  onRestore(selected);
                }}
              >
                Replace and restore
              </Button>
            </>
          }
        />
      )}
    </Dialog>
  );
}
