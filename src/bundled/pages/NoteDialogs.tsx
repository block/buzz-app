import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { MemberChange } from "../../features/channel-members/administration-protocol";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { useProfileGeneration } from "../../features/relay/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { avatarMedia } from "../../shared/avatar-source";
import { NoteAuthor, NoteTime } from "./NoteMetadata";
import readerStyles from "./NotesPage.module.css";
import { usePagesUi } from "./ui";
import { noteUrl, type Note } from "./model";
import type { NotesWorkspace } from "./workspace";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import {
  MenuItem,
  MenuNote,
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
  const {
    MembersDialog: ChannelMembersDialog,
    GeneralAccess: ChannelGeneralAccess,
  } = usePagesUi().conversation;
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
  const change = async (change: MemberChange, signal: AbortSignal) => {
    const role = change.role;
    if (role === "owner")
      throw new Error("Doc ownership cannot be transferred.");
    await run(
      (active) =>
        workspace.setMember(
          note,
          change.pubkey,
          role === "guest" ? "read" : role === "member" ? "edit" : role,
          active,
          { expectedRole: change.expectedRole },
        ),
      signal,
    );
  };
  return (
    <ChannelMembersDialog
      session={session}
      channelId={note.channel}
      trigger={trigger}
      close={onClose}
      title="Share access"
      nonMemberLabel="Not in this doc"
      description="Access includes the current doc and all retained revisions."
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
                Retry doc access
              </Button>
            </div>
          )}
          <ChannelGeneralAccess
            capability={access}
            recovery={session.recovery}
            channelId={channel}
            policy={{
              subject: "doc",
              allowPublic: false,
              visibilityDescription: (visibility) =>
                visibility === "public"
                  ? "Everyone in this community can read this doc and all retained revisions."
                  : "Only doc members can read this doc and all retained revisions.",
            }}
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
  const { profiles, viewer } = workspace.session;
  const names = useChannelIdentityNames(workspace.session, note.channel);
  const known = useSyncExternalStore(profiles.subscribe, profiles.snapshot);
  const generation = useProfileGeneration(profiles);
  const authors = useMemo(
    () => [
      ...new Set(page?.revisions.map((revision) => revision.event.pubkey)),
    ],
    [page],
  );
  useEffect(() => {
    if (!enabled) return;
    void generation;
    const release = profiles.reserve?.(authors.length);
    void profiles.ensure(authors, "background").catch(() => {});
    return release;
  }, [profiles, authors, enabled, generation]);
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
  return {
    page,
    error,
    busy,
    retry: () => setAttempt((value) => value + 1),
    author: (revision: Note) => {
      const author = revision.event.pubkey;
      const profile = known.get(author);
      const name =
        author === viewer
          ? "You"
          : names(
              author,
              profile?.name ?? formatPublicKey(author) ?? "Unknown author",
            );
      return {
        name,
        picture: avatarMedia(profile?.picture, workspace.session.media),
        isAgent: !!profile?.isAgent,
      };
    },
  };
}

export function NoteHistoryMenu({
  note,
  workspace,
  disabled,
  onSelect,
}: {
  note: Note;
  workspace: NotesWorkspace;
  disabled: boolean;
  onSelect(revision: string, offset: number): void;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const { page, error, busy, retry, author } = useRevisions(
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
      <MenuSubmenuPopup
        aria-label="Revision history"
        aria-busy={busy}
        style={{ inlineSize: "19rem", minInlineSize: 0 }}
      >
        {busy &&
          !page?.revisions.length &&
          ["latest", "previous"].map((row) => (
            <div
              key={row}
              aria-hidden="true"
              className={styles.revisionPlaceholder}
            >
              <Avatar alt="" fallback="" fallbackContent="" size="small" />
              <span className={`${styles.revision} flex-1`}>
                <span className="flex h-lh items-center">
                  <span className="h-2.5 w-3/5 rounded-full bg-affordance-disabled" />
                </span>
                <span className="flex h-lh items-center text-caption">
                  <span className="h-2 w-4/5 rounded-full bg-affordance-disabled" />
                </span>
              </span>
            </div>
          ))}
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
            <span aria-hidden="true" className="shrink-0">
              <NoteAuthor {...author(revision)} avatarOnly size="small" />
            </span>
            <span className={styles.revision}>
              <span
                className="truncate"
                title={revision.deleted ? undefined : revision.title}
              >
                {revision.deleted ? "Moved to Trash" : revision.title}
              </span>
              <span
                className={`${styles.revisionByline} text-caption text-subtle`}
              >
                <span className="truncate">
                  {author(revision).name} · <NoteTime note={revision.event} />
                </span>
                <span
                  className={`${styles.revisionId} truncate`}
                  title={revision.revision}
                >
                  ·&nbsp;{revision.revision.slice(0, 8)}
                </span>
                {revision.revision === note.revision && (
                  <span className="shrink-0">·&nbsp;Current</span>
                )}
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
  const Markdown = usePagesUi().conversation.Markdown;
  const { page, error, busy, retry, author } = useRevisions(
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
            {selected.deleted ? "Moved to Trash" : selected.title}
          </h2>
          <p className={`${readerStyles.byline} text-caption text-subtle`}>
            <NoteAuthor {...author(selected)} /> ·{" "}
            <NoteTime note={selected.event} /> · {selected.revision.slice(0, 8)}
          </p>
          <div className={styles.revisionPreview}>
            {selected.markdown ? (
              <Markdown
                content={selected.markdown}
                scale="document"
                session={workspace.session}
              />
            ) : (
              <p className="text-body-sm text-subtle">
                {selected.deleted ? "This doc is in Trash." : "Empty revision"}
              </p>
            )}
          </div>
        </section>
      )}
      {!busy && !error && !selected && (
        <p>Choose a version from Doc actions → Revision history.</p>
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
