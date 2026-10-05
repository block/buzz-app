import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { appendComposerResource } from "./composer-resource";
import { projectComposerDocument } from "./composer-document";
import { useEffectEvent } from "react";
import { useMessageEditScope } from "./MessageEditScope";
import { useMessageDeletion } from "./MessageManagement";
import { animate, useReducedMotion } from "motion/react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { SelectedMentionContext } from "./selected-mention-context";
import { DraftMentionRoster } from "./draft-mention-roster";
import {
  allowsOutsideMentions,
  archivedMention,
  mentionCandidates,
  rememberMention,
} from "./mention-candidates";
import {
  readComposerSnapshot,
  readComposerDocument,
  composerMarkdownContext,
} from "./composer-document";
import { useMessageEdit, lastEditableMessage } from "./useMessageEdit";
import { npubEncode } from "nostr-tools/nip19";
import type { ChannelMessage } from "../relay/contracts";
import { useFileDrop } from "./use-file-drop";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useNonmemberMentions } from "./useNonmemberMentions";
import { knownAgentPubkeys } from "../agents/known";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { rememberAgentsPreference } from "./mention-preferences";
import {
  isSessionCommand,
  sameSessionCommandDraft,
  type SessionCommandHandler,
} from "../sessions/session-command";
import {
  sessionReferenceTarget,
  type SessionReference,
} from "../sessions/session-reference";
import { SessionAgentControl } from "../sessions/SessionAgentControl";
import { sessionRecipients } from "../sessions/recipients";
import { TypingIndicator } from "./TypingIndicator";
import {
  ArrowUpIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { ComposerAttachments } from "./ComposerAttachments";
import { useAttachmentDraft } from "./attachment-draft";
import {
  useContext,
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import {
  readView,
  writeView,
  viewRevision,
  replaceView,
  clearView,
  subscribeView,
} from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import { isEmojiOnly, usesLargeEmojiPresentation } from "./emoji-size";
import {
  mentionDraft,
  followupDraft,
  type MentionDraft,
  type MentionRecipient,
} from "./mention-draft";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import { ComposerTools } from "../conversation/ComposerTools";
import { ComposerLinkDialog } from "./ComposerLinkDialog";
import { ComposerFormattingTools } from "./ComposerFormattingTools";
import type {
  ConversationExtensions,
  CompletionEdit,
  CompletionQuery,
  ComposerObservation,
  ComposerResource,
} from "../conversation/contracts";
import { ComposerCompletions } from "../conversation/ComposerCompletions";
import { useCompletionEditor } from "../conversation/useCompletionEditor";
import { formatMediaTime, mediaTimeReply } from "./media-timecode";
import { RichComposerInput } from "./RichComposerInput";
import { composerMarkdown } from "./composer-markdown";
import type {
  ComposerInputElement,
  ComposerCheckpoint,
  ComposerLinkEdit,
  ComposerFormat,
} from "./composer-dom";

const noChannels: ReturnType<RelaySession["channels"]["list"]> = {
  status: "idle",
  channels: [],
};
const noChannelSnapshot = () => noChannels;
const noChannelSubscription = () => () => {};

type AcceptedDraft = {
  id: string;
  next: MentionDraft;
  revision: string | null | undefined;
};
// Failed post-acceptance cleanup survives composer remounts within this session.
// This is recovery evidence only, not another persistent draft inventory.
const acceptedDrafts = new WeakMap<RelaySession, Map<string, AcceptedDraft>>();
function recoveryFor(session: RelaySession) {
  let recovery = acceptedDrafts.get(session);
  if (!recovery) {
    recovery = new Map();
    acceptedDrafts.set(session, recovery);
  }
  return recovery;
}
/** Share must distinguish a readable empty draft from malformed saved evidence. */
function savedShareDraft(
  raw: string | null | undefined,
): MentionDraft | undefined {
  if (raw === undefined) return;
  if (raw === null) return mentionDraft("");
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string") return mentionDraft(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.text !== "string" || !Array.isArray(record.recipients))
      return;
    if (record.document !== undefined && !readComposerSnapshot(record.document))
      return;
    if (
      mentionDraft({ text: record.text, recipients: record.recipients })
        .recipients.length !== record.recipients.length
    )
      return;
    return mentionDraft(value);
  } catch {
    return;
  }
}

function normalizedShareDraft(value: MentionDraft) {
  const draft = mentionDraft(value);
  return mentionDraft(
    projectComposerDocument(readComposerDocument(draft, draft.recipients))
      .draft,
  );
}

/** Host-only handoff. Never exposed through the plugin tool contract. */
export type ChannelDraftHandle = {
  appendReference(reference: SessionReference): boolean;
  readonly error: string | undefined;
};

export type MessageComposerProps = {
  startCommand?: SessionCommandHandler | undefined;
  suspended?: boolean | undefined;
  registerDraft?:
    | ((handle: ChannelDraftHandle | undefined) => void)
    | undefined;
  extensions?: ConversationExtensions | undefined;
  scope: string;
  session: RelaySession;
  channelId: string;
  channelName: string;
  label?: string | undefined;
  placeholder?: string | undefined;
  sessionConversation?: boolean | undefined;
  trailingTool?: ReactNode;
  inviteAgents?: boolean | undefined;
  onSend?: (id: string) => void;
  /** Inbox may retire only after saving the replacement or confirming no draft remains. */
  onDraftSaved?: ((id: string) => void) | undefined;
  /** Threads supply their own retained rows; channels use the shared window. */
  editMessages?: readonly ChannelMessage[] | undefined;
  onOpenLink?: ((target: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  threadRootId?: string;
  replyParentId?: string | undefined;
  replyContext?: ReactNode;
  mediaTimeSeconds?: number;
  clearMediaTime?(): void;
  /** Focus once when this conversation mounts, not when overlays close. */
  autoFocus?: boolean;
  focusRequest?: number;
  hideMediaTimeIndicator?: boolean;
  disabled?: boolean;
  /** A new conversation owns persistence and delivery before a channel exists. */
  submission?: {
    draftKey: string;
    initialDraft?: MentionDraft | string | undefined;
    /** A durable operation overrides disposable view state during recovery. */
    recoveredDraft?: MentionDraft | undefined;
    locked: boolean;
    disabled: boolean;
    canSubmit?: (draft: MentionDraft) => boolean;
    submit: (draft: MentionDraft) => void;
  };
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function MessageComposer(props: MessageComposerProps) {
  return (
    <Composer
      key={`${props.submission?.draftKey ?? ""}:${messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.threadRootId,
      )}`}
      {...props}
    />
  );
}
function Composer({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  label: customLabel,
  placeholder,
  onSend,
  onDraftSaved,
  editMessages,
  onOpenLink,
  canOpenLink,
  threadRootId,
  replyParentId,
  replyContext,
  mediaTimeSeconds,
  clearMediaTime,
  autoFocus = false,
  focusRequest,
  hideMediaTimeIndicator = false,
  disabled: requestedDisabled = false,
  submission,
  sessionConversation,
  inviteAgents = false,
  trailingTool,
  startCommand,
  registerDraft,
  suspended = false,
}: MessageComposerProps) {
  const active = useConversationPresentation();
  const list = useSyncExternalStore(
    session.channels?.get || sessionConversation
      ? session.channels.subscribeList
      : noChannelSubscription,
    session.channels?.get || sessionConversation
      ? session.channels.list
      : noChannelSnapshot,
    session.channels?.get || sessionConversation
      ? session.channels.list
      : noChannelSnapshot,
  );
  const readOnly =
    !submission &&
    !!session.channels?.get &&
    !list.channels.some(
      (channel) =>
        channel.id === channelId && !channel.readOnly && !channel.archived,
    );
  const cached = !!list.channels.find((channel) => channel.id === channelId)
    ?.cached;
  const disabled = requestedDisabled || readOnly;
  const [sending, setSending] = useState(false);
  const sendAttempt = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => sendAttempt.current?.abort(), []);
  useLayoutEffect(() => {
    if (disabled || !active) sendAttempt.current?.abort();
  }, [disabled, active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retargeting invalidates an in-flight send, not the root-keyed draft.
  useLayoutEffect(() => () => sendAttempt.current?.abort(), [replyParentId]);
  const inputId = useId();
  const draftKey =
    submission?.draftKey ??
    (threadRootId
      ? `draft:${channelId}:thread:${threadRootId}`
      : `draft:${channelId}`);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [admitting, setAdmitting] = useState(false);
  const admission = useRef(false);
  const live = useRef(true);
  const permitted = useRef(!disabled);
  permitted.current = !disabled && active;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const parentChannelId = list.channels.find(
    (item) => item.id === channelId,
  )?.parentChannelId;
  const mentionRoster = useContext(DraftMentionRoster);
  const agentChoices = inviteAgents || !!sessionConversation;
  const recoveryKey = `${scope}:${draftKey}`;
  const [accepted, setAccepted] = useState(() => {
    if (submission) return;
    const recovery = recoveryFor(session);
    const pending = recovery.get(recoveryKey);
    const current = viewRevision(scope, draftKey);
    if (pending && current !== undefined && current !== pending.revision) {
      recovery.delete(recoveryKey); // Deleted or replaced while unmounted.
      return;
    }
    return pending;
  });
  const revision = useRef(viewRevision(scope, draftKey));
  const dirty = useRef(false);
  const writing = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  // Share's review snapshot is UI evidence, not another persistence owner.
  const [shareReview, setShareReview] = useState<{
    raw: string | null | undefined;
  }>();
  const [value, updateDraft] = useState(() =>
    mentionDraft(
      accepted?.next ??
        submission?.recoveredDraft ??
        readView<unknown>(scope, draftKey, submission?.initialDraft ?? ""),
    ),
  );
  const retained = useRef<ComposerCheckpoint | null>(null);
  const draft = value.text;
  const valueRef = useRef(value);
  const caret = useRef<number | undefined>(undefined);
  const input = useRef<ComposerInputElement>(null);
  const commandGeneration = useRef(startCommand?.generation);
  useEffect(() => {
    if (!startCommand) return;
    commandGeneration.current = startCommand.generation;
  }, [startCommand?.generation, startCommand]);
  const focusOnMount = useRef(
    autoFocus && !disabled && typeof document !== "undefined"
      ? document.activeElement
      : undefined,
  );
  useEffect(() => {
    // A navigation/dialog owner may restore focus during this commit. Let that
    // explicit handoff win over the conversation's default initial focus.
    if (!focusOnMount.current) return;
    const focus = () => {
      const previous = focusOnMount.current;
      if (
        !previous ||
        (previous !== document.activeElement &&
          (previous.isConnected || document.activeElement !== document.body))
      )
        return;
      const editor = input.current;
      if (!editor || editor.closest("[inert]")) return;
      // A conversation can finish loading behind an already-focused dialog.
      // Its default focus must not interrupt that modal's explicit owner.
      const modal = document.activeElement?.closest(
        'dialog[open], [aria-modal="true"]',
      );
      if (modal && !modal.contains(editor)) return;
      const end = editor.value.length;
      editor.focus();
      if (document.activeElement !== editor) return;
      editor.setSelectionRange(end, end);
      // Effect replay recreates the editor; retain this successful focus handoff.
      focusOnMount.current = editor;
    };
    const inertAncestor = input.current?.closest("[inert]");
    if (inertAncestor) {
      const observer = new MutationObserver(() => {
        if (!inertAncestor.hasAttribute("inert")) {
          observer.disconnect();
          focus();
        }
      });
      observer.observe(inertAncestor, {
        attributes: true,
        attributeFilter: ["inert"],
      });
      return () => observer.disconnect();
    }
    focus();
  }, []);
  const nonmembers = useNonmemberMentions(session, channelId, () => {
    if (permitted.current) input.current?.focus();
  });
  useEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  const restoreSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const [linkEdit, setLinkEdit] = useState<ComposerLinkEdit | null>(null);
  if (!active && linkEdit) setLinkEdit(null);
  const [activeFormats, setActiveFormats] = useState<readonly ComposerFormat[]>(
    [],
  );
  const saveDraft = (next: MentionDraft) => {
    if (JSON.stringify(next) === JSON.stringify(valueRef.current)) return false;
    valueRef.current = next;
    updateDraft(next);
    if (!editing.target) {
      if (submission) writeView(scope, draftKey, next);
      else {
        dirty.current = true;
        if (!conflict && !accepted) persist(next);
      }
    }
    return true;
  };
  function persist(next: MentionDraft, expected = revision.current) {
    writing.current = true;
    const result = replaceView(scope, draftKey, expected, next);
    writing.current = false;
    if (result === "saved") revision.current = JSON.stringify(next);
    setConflict(result === "changed");
    setStorageFailed(result === "failed");
    return result;
  }
  const [error, setError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const focusRestoredDraft = useRef(false);
  const beforeEdit = useRef<
    { value: MentionDraft; restore(): void } | undefined
  >(undefined);
  const editing = useMessageEdit(session, () => {
    const saved = beforeEdit.current;
    if (!saved) return;
    valueRef.current = saved.value;
    updateDraft(saved.value);
    saved.restore();
    focusRestoredDraft.current = true;
    beforeEdit.current = undefined;
    setError(undefined);
    caret.current = undefined;
    setLinkEdit(null);
    completion.invalidate();
  });
  const editScope = useMessageEditScope();
  const editableRows = () =>
    editMessages ??
    editScope?.exactRows?.() ??
    (threadRootId
      ? []
      : (session.channels.window?.(channelId).rows ?? [])
    ).filter((row) => sessionConversation || !row.threadRootId);
  const editDisabled =
    disabled ||
    !!list.channels.find((channel) => channel.id === channelId)?.archived ||
    !!list.channels.find((channel) => channel.id === channelId)?.readOnly;
  const editingDisabled =
    !!shareReview ||
    disabled ||
    admitting ||
    sending ||
    !!accepted ||
    !!submission?.locked ||
    !!startCommand?.locked ||
    (editing.target && (editing.locked || editDisabled)) ||
    false;
  const label = editing.target
    ? "Edit message"
    : (customLabel ??
      (threadRootId ? "Reply to thread" : `Message #${channelName}`));
  const attachments = useAttachmentDraft(
    session,
    `${scope}:${draftKey}`,
    channelId,
  );
  const picker = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const canAttach = !submission && !!session.attachments;
  const channelType = list.channels.find(
    (item) => item.id === channelId,
  )?.channelType;
  const commandDestination =
    !threadRootId &&
    !sessionConversation &&
    channelType !== "dm" &&
    channelType !== "session";
  const showSessionCommand =
    !!startCommand &&
    !startCommand.locked &&
    !editingDisabled &&
    !threadRootId &&
    !sessionConversation &&
    !attachments.items.length &&
    isSessionCommand(draft);
  useEffect(() => {
    if (disabled) attachments.store.cancel();
  }, [disabled, attachments.store]);
  const dragging = useFileDrop(
    form,
    active && !suspended && canAttach && !editingDisabled && !editing.target,
    attachFiles,
  );
  function attachFiles(files: readonly File[]) {
    if (!permitted.current || editingDisabled || !files.length) return;
    if (editing.target) {
      setAttachmentError("Finish editing before attaching new files.");
      return;
    }
    if (!canAttach) {
      setAttachmentError(
        submission
          ? "Create this conversation before attaching files."
          : "Uploads are unavailable on this connection.",
      );
      return;
    }
    try {
      attachments.store.add(files);
      setAttachmentError(undefined);
    } catch (reason) {
      setAttachmentError(
        reason instanceof Error ? reason.message : "Could not attach files.",
      );
    }
  }
  const outbox = session.outbox;
  const emojiCatalog = useSyncExternalStore(
    suspended ? noChannelSubscription : session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const largeEmojiDraft = usesLargeEmojiPresentation(
    draft,
    emojiCatalog.entries,
  );
  const completion = useCompletionEditor(
    input,
    active && !suspended && !editingDisabled && !!outbox?.supports(9),
  );
  function loadSaved(raw: string | null, preserveHistory = false) {
    let next: MentionDraft;
    try {
      next = mentionDraft(JSON.parse(raw ?? "null"));
    } catch {
      next = mentionDraft("");
    }
    revision.current = raw;
    dirty.current = false;
    valueRef.current = next;
    updateDraft(next);
    if (!preserveHistory) input.current?.reset(next);
    else focusRestoredDraft.current = true;
    setShareReview(undefined);
    completion.invalidate();
    setLinkEdit(null);
    restoreSelection.current = undefined;
    caret.current = undefined;
    setConflict(false);
    setStorageFailed(false);
  }
  const reconcileDraft = useEffectEvent(() => {
    if (submission || editing.target || writing.current || accepted) return;
    const current = viewRevision(scope, draftKey);
    if (current === undefined || current === revision.current) return;
    if (startCommand && isSessionCommand(valueRef.current.text)) {
      setConflict(true);
      setError(
        "This command editor is stale. Review the saved draft or reopen the channel before starting another session.",
      );
    } else if (dirty.current || sendAttempt.current || shareReview)
      setConflict(true);
    else loadSaved(current);
  });
  const editingDraft = !!editing.target;
  useEffect(() => {
    if (submission) return;
    const stop = subscribeView(scope, () => reconcileDraft());
    // Reconcile changes while message-edit mode or mounting paused this listener.
    void editingDraft;
    reconcileDraft();
    return stop;
  }, [scope, submission, editingDraft]);
  function resolveDraft(keep: boolean) {
    const current = viewRevision(scope, draftKey);
    if (current === undefined) {
      setStorageFailed(true);
      return;
    }
    if (shareReview && current !== shareReview.raw) {
      setShareReview({ raw: current });
      return; // Review the newly observed content before replacing either draft.
    }
    if (shareReview && !savedShareDraft(current)) return;
    if (keep) {
      setShareReview(undefined);
      dirty.current = true;
      persist(valueRef.current, current);
    } else loadSaved(current, !!shareReview);
  }
  function finishDraft(pending: AcceptedDraft) {
    const result = persist(pending.next, pending.revision);
    // No stale sent text needs cleanup if nothing was saved and absence is
    // still readable. Keep the normal save attempt for remembered-agent drafts.
    if (
      result === "failed" &&
      (pending.revision !== null || viewRevision(scope, draftKey) !== null)
    )
      return;
    recoveryFor(session).delete(recoveryKey);
    setAccepted(undefined);
    if (result === "changed") {
      // Another editor owns this revision. Acceptance cannot erase its work.
      const current = viewRevision(scope, draftKey);
      if (current !== undefined) loadSaved(current);
      return;
    }
    dirty.current = result === "failed" && !!pending.next.text.trim();
    // An unsaved prefill stays editable here with the ordinary save warning.
    if (!dirty.current) onDraftSaved?.(pending.id);
  }
  useEffect(() => {
    if (!suspended && outbox?.supports(9)) void session.emoji.ensure();
  }, [session, outbox, suspended]);
  useLayoutEffect(() => {
    if (suspended) {
      setLinkEdit(null);
      return;
    }
    completion.composing.current = false;
  }, [suspended, completion.composing]);
  useLayoutEffect(() => {
    if (suspended || !input.current) return;
    // Delivery closes while the input is still disabled. Focus only after React
    // has committed the restored, editable draft; preserve its saved selection.
    if (focusRestoredDraft.current) {
      focusRestoredDraft.current = false;
      input.current?.focus();
    }
    if (restoreSelection.current) {
      const { start, end } = restoreSelection.current;
      input.current?.focus();
      input.current?.setSelectionRange(start, end);
      restoreSelection.current = undefined;
      return;
    }
    if (caret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  const requestDeletion = useMessageDeletion();
  const startEdit = useEffectEvent((row: ChannelMessage) => {
    if (
      !permitted.current ||
      suspended ||
      editingDisabled ||
      editDisabled ||
      submission ||
      !input.current
    )
      return;
    const current = editableRows().find((item) => item.id === row.id);
    if (!current || !lastEditableMessage(session, [current])) {
      setError("This message is no longer available to edit.");
      return;
    }
    if (editing.target) {
      setError("Finish or cancel your current edit first.");
      input.current.focus();
      return;
    }
    completion.invalidate();
    beforeEdit.current = {
      value: valueRef.current,
      restore: input.current.checkpoint(),
    };
    const next = mentionDraft(editing.start(current));
    valueRef.current = next;
    updateDraft(next);
    input.current.reset(next);
    setLinkEdit(null);
    caret.current = next.text.length;
    setError(undefined);
  });
  useEffect(() => {
    if (!editScope || suspended) return;
    const start = (row: ChannelMessage) => startEdit(row);
    editScope.current = start;
    editScope.input.current = input.current;
    return () => {
      if (editScope.current === start) {
        editScope.current = undefined;
        editScope.input.current = null;
      }
    };
  }, [editScope, suspended]);
  function insert(
    text: string,
    recipient?: MentionRecipient,
    range?: CompletionQuery,
  ) {
    if (
      !permitted.current ||
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      // DOM props are committed before child layout effects; closures can still
      // carry the preceding render's enabled state during that interval.
      input.current.disabled ||
      input.current.readOnly ||
      typeof text !== "string"
    )
      return false;
    // Edits replace prose; they do not change the original notification recipients.
    if (editing.target && recipient) {
      text = `nostr:${npubEncode(recipient.pubkey)} `;
      recipient = undefined;
    }
    if (
      recipient &&
      !mentionCandidates(session, channelId, agentChoices, mentionRoster, [
        recipient,
      ]).some((c) => c.recipient.pubkey === recipient.pubkey)
    ) {
      setError(
        "This recipient is no longer available. Remove it or refresh choices.",
      );
      return false;
    }
    if (recipient && valueRef.current.recipients.length >= 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    completion.invalidate();
    if (!input.current.insertText(text, recipient, range)) {
      setError("Message is too long to insert text");
      return false;
    }
    if (recipient) rememberMention(session, channelId, recipient.pubkey);
    setError(undefined);
    return true;
  }
  function insertMention(recipient: MentionRecipient) {
    if (
      !recipient ||
      typeof recipient.pubkey !== "string" ||
      !/^[0-9a-f]{64}$/.test(recipient.pubkey) ||
      typeof recipient.name !== "string" ||
      !recipient.name.trim()
    )
      return false;
    return insert(`@${recipient.name} `, recipient);
  }
  function insertResource(resource: ComposerResource): true | string {
    if (
      !permitted.current ||
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected
    )
      return "The message can't be edited right now";
    completion.invalidate();
    return input.current.insertResource(resource);
  }

  const shareFailure = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!registerDraft) return;
    let current = true;
    const handle: ChannelDraftHandle = {
      get error() {
        return shareFailure.current;
      },
      appendReference(reference) {
        const target = sessionReferenceTarget(reference.href);
        const channel = session.channels
          .list()
          .channels.find((item) => item.id === channelId);
        if (
          !current ||
          !active ||
          editing.target ||
          submission ||
          threadRootId ||
          !outbox?.supports(9) ||
          !session.viewer ||
          completion.composing.current ||
          session.channels.list().status !== "ready" ||
          !channel ||
          channel.archived ||
          channel.readOnly ||
          (channel.channelType !== "stream" &&
            channel.channelType !== "forum") ||
          (channel.members !== undefined &&
            !channel.members.includes(session.viewer)) ||
          !target ||
          target.channelId !== channelId
        ) {
          shareFailure.current =
            "The channel draft is unavailable. Return to Channel and try again.";
          return false;
        }
        const stored = viewRevision(scope, draftKey);
        const saved = input.current?.captureCheckpoint() ?? retained.current;
        if (
          conflict ||
          stored === undefined ||
          revision.current === undefined ||
          stored !== revision.current ||
          !savedShareDraft(stored) ||
          !saved ||
          JSON.stringify(normalizedShareDraft(saved.draft)) !==
            JSON.stringify(normalizedShareDraft(valueRef.current))
        ) {
          if (stored === undefined) setStorageFailed(true);
          setShareReview({ raw: stored });
          setConflict(true);
          shareFailure.current =
            "The saved channel draft changed in another window or could not be read. Return to Channel to review it before sharing.";
          return false;
        }

        if (
          editingDisabled ||
          input.current?.disabled ||
          input.current?.readOnly
        ) {
          shareFailure.current =
            "The channel draft is unavailable. Return to Channel and try again.";
          return false;
        }
        const tr = appendComposerResource(
          saved.state,
          { uri: reference.href, label: reference.label },
          16000,
        );
        if (typeof tr === "string") {
          shareFailure.current = tr;
          return false;
        }
        const state = saved.state.apply(tr);
        const next = projectComposerDocument(state.doc).draft;
        retained.current = {
          ...saved,
          state,
          draft: next,
          separateHistory: true,
        };
        input.current?.restoreCheckpoint(retained.current);
        // The readable, unchanged baseline permits a local handoff even at quota.
        saveDraft(next);
        completion.invalidate();
        caret.current = next.text.length;
        shareFailure.current = undefined;
        setError(undefined);
        input.current?.focus();
        return true;
      },
    };
    registerDraft(handle);
    return () => {
      current = false;
      registerDraft(undefined);
    };
  });
  useLayoutEffect(() => {
    if (!startCommand || editing.target || submission || threadRootId) return;
    return startCommand.bindEditor((expected) => {
      if (suspended || conflict || accepted) return false;
      const empty = mentionDraft("");
      const matches = (draft: MentionDraft) =>
        sameSessionCommandDraft(draft, expected) ||
        sameSessionCommandDraft(draft, empty);
      const stored = viewRevision(scope, draftKey);
      if (stored === undefined || stored !== revision.current) return false;
      const saved = savedShareDraft(stored);
      if (!saved || !matches(valueRef.current) || !matches(saved)) return false;
      // Clear and verify durable input before the command owner advances its
      // generation. Do not report an optimistic in-memory save as cleanup.
      writing.current = true;
      try {
        clearView(scope, draftKey);
      } finally {
        writing.current = false;
      }
      loadSaved(null);
      return true;
    });
  });

  function replaceCompletion(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ) {
    if (
      !completion.valid(observation) ||
      valueRef.current.text !== observation.text
    )
      return false;
    if (key === " ") {
      const doc = readComposerSnapshot(valueRef.current.document);
      if (
        doc &&
        composerMarkdownContext(doc).protected.some(
          (r) => query.start < r.end && query.end > r.start,
        )
      )
        return false;
    }
    if ("mention" in edit && edit.mention)
      return insert(`@${edit.mention.name} `, edit.mention, query);
    return (
      typeof edit.text === "string" &&
      insert(
        `${edit.text}${isEmojiOnly(edit.text, emojiCatalog.entries) ? "" : " "}`,
        undefined,
        query,
      )
    );
  }
  const currentAdmission = () =>
    live.current &&
    permitted.current &&
    !sendAttempt.current?.signal.aborted &&
    session.channels.list().channels.find((item) => item.id === channelId)
      ?.parentChannelId === parentChannelId;
  async function prepareRecipients(explicit: readonly string[]) {
    const channel = await session.workSessions.refreshMembership(channelId);
    if (!currentAdmission())
      throw new Error("The session changed. Review its channel and retry.");
    const recipients = [
      ...sessionRecipients(
        channel,
        session.profiles.snapshot(),
        session.agentChoices.snapshot(),
        session.viewer,
        explicit,
      ),
    ];
    const missing = recipients.filter((key) => !channel.members?.includes(key));
    if (missing.length) {
      await session.agentChoices.refresh();
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
      await session.workSessions.addAgents(
        channelId,
        missing,
        currentAdmission,
      );
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
    }
    return recipients;
  }
  function selectAgent(key: string) {
    if (!permitted.current || admission.current) return;
    setSelectedAgent(key);
    setError(undefined);
  }
  async function send() {
    if (!permitted.current || suspended || conflict) return;
    if (editing.target) {
      if (editDisabled || editing.locked) return;
      if (!valueRef.current.text.trim()) {
        if (editing.target.attachments.length) {
          setError(
            "Keep attachment links unchanged. To remove this message, use Delete message.",
          );
          return;
        }
        if (requestDeletion && session.outbox?.supports(5))
          requestDeletion(editing.target, editing.close);
        return;
      }
      editing.save(
        composerMarkdown(valueRef.current),
        editableRows().find((row) => row.id === editing.target?.id),
      );
      return;
    }
    if (
      disabled ||
      accepted ||
      startCommand?.locked ||
      conflict ||
      admission.current ||
      submission?.disabled ||
      submission?.canSubmit?.(valueRef.current) === false ||
      (!submission && (input.current?.readOnly || input.current?.disabled)) ||
      (!draft.trim() && !attachments.items.length) ||
      attachments.blocked ||
      sendAttempt.current ||
      !outbox
    )
      return;
    const recovering = !submission && recoveryFor(session).get(recoveryKey);
    if (recovering) {
      setAccepted(recovering);
      valueRef.current = recovering.next;
      updateDraft(recovering.next);
      input.current?.reset(recovering.next);
      return;
    }
    if (!submission && viewRevision(scope, draftKey) !== revision.current) {
      setConflict(true);
      return;
    }
    const savedRevision = revision.current;
    const attempt = new AbortController();
    sendAttempt.current = attempt;
    const captured = valueRef.current;
    const capturedAttachments = attachments.store.snapshot();
    try {
      if (captured.recipients.some((p) => archivedMention(session, p.pubkey)))
        throw new Error(
          "A selected recipient is archived. Remove it before sending.",
        );
      if (submission) {
        submission.submit(captured);
        return;
      }
      if (commandDestination && isSessionCommand(captured.text)) {
        if (!startCommand)
          throw new Error("Sessions is unavailable. Nothing was sent.");
        if (capturedAttachments.length)
          throw new Error(
            "Remove attachments before starting a session command.",
          );
        admission.current = true;
        setAdmitting(true);
        await startCommand.submit(captured, commandGeneration.current ?? -1);
        return;
      }
      let references: readonly string[] = [];
      let recipients = captured.recipients.length
        ? captured.recipients.map((item) => item.pubkey)
        : selectedAgent
          ? [selectedAgent]
          : [];
      if (sessionConversation) {
        admission.current = true;
        setAdmitting(true);
        recipients = await prepareRecipients(recipients);
      } else if (recipients.length) {
        const channel = session.channels
          .list()
          .channels.find((item) => item.id === channelId);
        if (channel?.members && allowsOutsideMentions(channel)) {
          const missing = captured.recipients.filter(
            (person) => !channel.members?.includes(person.pubkey),
          );
          if (missing.length && channel?.channelType === "dm") {
            // Nobody can be added to a DM, so there is no choice to offer:
            // outside people become references without a prompt.
            references = missing.map((person) => person.pubkey);
            recipients = recipients.filter((key) => !references.includes(key));
          } else if (missing.length) {
            setSending(true);
            setError(undefined);
            const decision = await nonmembers.prepare(
              missing,
              attempt.signal,
              () =>
                valueRef.current === captured &&
                attachments.store.snapshot() === capturedAttachments &&
                permitted.current,
            );
            if (decision === null) return;
            references = decision;
            recipients = recipients.filter((key) => !references.includes(key));
          }
        }
      }
      attempt.signal.throwIfAborted();
      if (
        valueRef.current !== captured ||
        attachments.store.snapshot() !== capturedAttachments
      )
        return;
      if (viewRevision(scope, draftKey) !== savedRevision) {
        setConflict(true);
        return;
      }
      const content =
        threadRootId && mediaTimeSeconds !== undefined
          ? mediaTimeReply(mediaTimeSeconds, composerMarkdown(captured))
          : composerMarkdown(captured);
      const uploaded = capturedAttachments.flatMap((item) =>
        item.uploaded ? [item.uploaded] : [],
      );
      const agents = knownAgentPubkeys(
        session.profiles.snapshot(),
        session.agentChoices.snapshot(),
      );
      const next = followupDraft(
        rememberAgentsPreference()
          ? captured.recipients.filter(
              (item) =>
                agents.has(item.pubkey) &&
                mentionCandidates(
                  session,
                  channelId,
                  agentChoices,
                  mentionRoster,
                ).some((c) => c.recipient.pubkey === item.pubkey),
            )
          : [],
      );
      const id = threadRootId
        ? session.messages.reply(
            channelId,
            threadRootId,
            content,
            recipients,
            uploaded,
            ...(replyParentId || references.length ? [replyParentId] : []),
            ...(references.length ? [references] : []),
          )
        : references.length
          ? session.messages.send(
              channelId,
              content,
              recipients,
              uploaded,
              undefined,
              references,
            )
          : session.messages.send(channelId, content, recipients, uploaded);
      const pending = { id, next, revision: savedRevision };
      recoveryFor(session).set(recoveryKey, pending);
      setAccepted(pending);
      attachments.store.clear();
      completion.invalidate();
      clearMediaTime?.();
      const changed = JSON.stringify(next) !== JSON.stringify(valueRef.current);
      valueRef.current = next;
      updateDraft(next);
      // An unchanged prefill may not render. Do not leave a caret command for
      // the next keystroke to consume after inserting its first character.
      caret.current = changed ? next.text.length : undefined;
      input.current?.reset(next);
      input.current?.focus();
      if (!changed)
        input.current?.setSelectionRange(next.text.length, next.text.length);
      setError(undefined);
      onSend?.(id);
      finishDraft(pending);
    } catch (reason) {
      if (live.current && !attempt.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      admission.current = false;
      if (sendAttempt.current === attempt) {
        sendAttempt.current = null;
        if (live.current) {
          setSending(false);
          setAdmitting(false);
        }
      }
    }
  }
  const readingOnly = !outbox?.supports(9) && !cached;
  const context = (
    <div
      className={styles.composerContext}
      data-reserve-typing={!submission || readingOnly || undefined}
    >
      {readingOnly || (!disabled && !submission && !editing.target) ? (
        <TypingIndicator
          session={session}
          channelId={channelId}
          threadRootId={threadRootId}
        />
      ) : null}
      {extensions?.accessories && (
        <ComposerAccessories
          registry={extensions.accessories}
          session={session}
          scope={scope}
          channelId={channelId}
          threadRootId={threadRootId}
          canOpen={(target) => canOpenLink?.(target) ?? false}
          open={(target) => onOpenLink?.(target) ?? false}
        />
      )}
    </div>
  );
  const renderLeadingTools = (tools: ReactNode) => (
    <>
      <div className={styles.composerLeadingTools}>
        {tools}
        {!!value.recipients.length && (
          <RecipientAvatars
            session={session}
            recipients={value.recipients}
            disabled={editingDisabled}
            remove={(pubkey) => input.current?.removeRecipient(pubkey)}
          />
        )}
      </div>
      {canAttach && (
        <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(event) => {
              attachFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <IconButton
            size="sm"
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={editingDisabled || !!editing.target}
            onClick={() => picker.current?.click()}
            icon={<PaperclipIcon size={16} />}
          />
        </>
      )}
    </>
  );
  if (suspended) return null;
  if (readingOnly)
    return (
      <>
        {context}
        <footer className={styles.composer}>
          This relay connection supports reading only.
        </footer>
      </>
    );
  return (
    <SelectedMentionContext.Provider value={value.recipients}>
      {context}
      {active && nonmembers.dialog}
      <form
        ref={form}
        className={styles.composer}
        data-file-drag={dragging || undefined}
        data-editing={!!editing.target || undefined}
        onKeyDown={(event) => {
          if (
            editing.target &&
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !completion.composing.current
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!editing.busy) editing.close();
          }
        }}
        onPasteCapture={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          attachFiles(files);
        }}
        aria-label={
          editing.target
            ? "Edit message"
            : threadRootId
              ? "Reply to thread"
              : `Send a message to ${channelName}`
        }
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {editing.target && (
          <div className={styles.composerEditHeader}>
            <PencilSimpleIcon size={18} />
            <span>Editing message</span>
            <IconButton
              type="button"
              size="sm"
              aria-label={editing.locked ? "Close edit" : "Cancel edit"}
              disabled={editing.busy}
              onClick={editing.close}
              icon={<XIcon size={18} />}
            />
          </div>
        )}
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        {active && extensions?.completions && (
          <ComposerCompletions
            registry={extensions.completions}
            editor={completion}
            input={input}
            session={session}
            scope={scope}
            channelId={channelId}
            threadRootId={threadRootId}
            inviteAgents={agentChoices && !editing.target}
            replace={replaceCompletion}
            resolved={value}
          />
        )}
        {dragging && <p role="status">Drop files to attach</p>}
        {attachmentError && (
          <ToastNotice
            title="Could not attach file"
            description={attachmentError}
            onDismiss={() => setAttachmentError(undefined)}
          />
        )}
        <div className={styles.composerContent}>
          {!editing.target && (
            <ComposerAttachments
              media={session.media}
              items={attachments.items}
              disabled={editingDisabled}
              remove={attachments.store.remove}
              retry={attachments.store.retry}
            />
          )}
          {showSessionCommand && (
            <div
              id={`${inputId}-session-command`}
              className={styles.sessionCommandHint}
              role="status"
              aria-live="polite"
            >
              <strong>New session</strong>{" "}
              <span>Select an @agent and add a prompt.</span>
            </div>
          )}
          <div className={styles.composerInput}>
            <RichComposerInput
              retained={retained}
              inviteAgents={agentChoices}
              ref={input}
              id={inputId}
              disabled={editingDisabled}
              value={draft}
              draft={value}
              session={session}
              scope={scope}
              channelId={channelId}
              extensions={extensions}
              emoji={emojiCatalog.entries}
              onDraftChange={(next) => {
                saveDraft(next);
                completion.observe(true);
              }}
              onFormatsChange={setActiveFormats}
              onEditLink={setLinkEdit}
              data-single-emoji={largeEmojiDraft || undefined}
              maxLength={16000}
              aria-describedby={
                showSessionCommand ? `${inputId}-session-command` : undefined
              }
              aria-label={label}
              placeholder={placeholder ?? label}
              onFocus={() => completion.observe(true)}
              onBlur={() => {
                completion.invalidate();
              }}
              onSelect={() => {
                completion.observe();
              }}
              onCompositionStart={() => {
                completion.composing.current = true;
                completion.invalidate();
              }}
              onCompositionEnd={() => {
                completion.composing.current = false;
                completion.observe(true);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  completion.composing.current
                )
                  return;
                if (
                  event.shiftKey &&
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  completion.invalidate();
                  return;
                }
                if (completion.keys.current?.(event)) return;
                if (
                  event.key === "ArrowUp" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.repeat &&
                  !event.defaultPrevented &&
                  !editingDisabled &&
                  !editDisabled &&
                  !submission &&
                  !editing.target &&
                  event.currentTarget.value === "" &&
                  !valueRef.current.recipients.length &&
                  !attachments.items.length
                ) {
                  const target = lastEditableMessage(session, editableRows());
                  if (target) {
                    event.preventDefault();
                    startEdit(target);
                  }
                  return;
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  event.preventDefault();
                  if (!event.repeat || !editing.target) send();
                }
              }}
            />
          </div>
        </div>
        {!editing.target && replyContext}
        {!editing.target &&
          threadRootId &&
          mediaTimeSeconds !== undefined &&
          !hideMediaTimeIndicator && (
            <div className={styles.mediaComposerAnchor}>
              <span>Commenting at {formatMediaTime(mediaTimeSeconds)}</span>
              <IconButton
                size="compact"
                type="button"
                onClick={clearMediaTime}
                aria-label="Remove video time"
                icon={<XIcon size={13} />}
              />
            </div>
          )}
        <div className={styles.composerActions}>
          {active && (
            <ComposerFormattingTools
              disabled={editingDisabled}
              activeFormats={activeFormats}
              toggleFormat={(format) => input.current?.toggleFormat(format)}
              editLink={() => {
                const edit = input.current?.editLink();
                if (edit) setLinkEdit(edit);
              }}
            >
              {extensions ? (
                <ComposerTools
                  registry={extensions.tools}
                  renderLeading={renderLeadingTools}
                  session={session}
                  scope={scope}
                  channelId={channelId}
                  threadRootId={threadRootId}
                  disabled={editingDisabled}
                  inviteAgents={agentChoices && !editing.target}
                  insertText={(text) => insert(text)}
                  insertMention={insertMention}
                  insertResource={insertResource}
                  focus={() => input.current?.focus()}
                />
              ) : (
                renderLeadingTools(null)
              )}
            </ComposerFormattingTools>
          )}
          {active &&
            !editing.target &&
            (trailingTool ??
              (sessionConversation ? (
                <SessionAgentControl
                  session={session}
                  channelId={channelId}
                  value={selectedAgent}
                  onChange={selectAgent}
                  disabled={editingDisabled}
                />
              ) : null))}
          <IconButton
            variant={
              draft.trim() || attachments.items.length ? "primary" : "ghost"
            }
            size="toolbar"
            type="submit"
            aria-label={editing.target ? "Save changes" : "Send message"}
            title={editing.target ? "Save changes" : "Send message"}
            disabled={
              !!conflict ||
              disabled ||
              (!editing.target && (!!accepted || conflict)) ||
              (!!editing.target && (editing.locked || editDisabled)) ||
              admitting ||
              sending ||
              startCommand?.locked ||
              submission?.disabled ||
              submission?.canSubmit?.(value) === false ||
              (!editing.target && attachments.blocked) ||
              (!draft.trim() &&
                !attachments.items.length &&
                !(
                  editing.target &&
                  requestDeletion &&
                  session.outbox?.supports(5)
                ))
            }
            icon={<ArrowUpIcon size={16} />}
          />
        </div>
        {startCommand?.notice}
        {readOnly && commandDestination && isSessionCommand(draft) && (
          <p role="alert">This channel is unavailable. Nothing was sent.</p>
        )}
        {(error || editing.error) && (
          <p role="alert">{error ?? editing.error}</p>
        )}
        {!editing.target &&
          !submission &&
          (accepted || conflict || storageFailed) && (
            <section
              aria-label={shareReview ? "Channel draft conflict" : undefined}
            >
              {shareReview && (
                <p>
                  {savedShareDraft(shareReview.raw)?.text ??
                    "The saved draft could not be read. Restore readable saved content before reviewing it."}
                </p>
              )}
              <p role="alert">
                {accepted
                  ? "Message accepted. Could not update the saved draft. Retry cleanup before sending again."
                  : conflict
                    ? "This draft changed elsewhere. Your edits are kept here; choose which draft to keep."
                    : "Could not save this draft on this device. Your edits are kept here."}
              </p>
              {accepted ? (
                <Button type="button" onClick={() => finishDraft(accepted)}>
                  Retry draft cleanup
                </Button>
              ) : conflict ? (
                <>
                  <Button type="button" onClick={() => resolveDraft(false)}>
                    {shareReview && !savedShareDraft(shareReview.raw)
                      ? "Retry saved draft"
                      : "Load saved draft"}
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      !!shareReview && !savedShareDraft(shareReview.raw)
                    }
                    onClick={() => resolveDraft(true)}
                  >
                    Keep my draft
                  </Button>
                </>
              ) : (
                <Button type="button" onClick={() => persist(valueRef.current)}>
                  Retry draft save
                </Button>
              )}
            </section>
          )}
        {editing.retryable && (
          <>
            <p role="status">Your edit is still in the outbox.</p>
            <Button
              type="button"
              disabled={editDisabled}
              onClick={editing.retry}
            >
              Retry edit
            </Button>
          </>
        )}
        {(error || editing.error) && emojiCatalog.status === "error" && (
          <Button
            type="button"
            disabled={editingDisabled}
            onClick={() => {
              void session.emoji.refresh().then(() => {
                if (
                  input.current?.isConnected &&
                  session.emoji.snapshot().status === "ready"
                ) {
                  setError(undefined);
                  editing.clearError();
                }
              });
            }}
          >
            Retry message preparation
          </Button>
        )}
      </form>
      {active && linkEdit && (
        <ComposerLinkDialog
          edit={linkEdit}
          input={input}
          finalFocus={() => (permitted.current ? input.current : false)}
          disabled={editingDisabled}
          close={() => setLinkEdit(null)}
        />
      )}
    </SelectedMentionContext.Provider>
  );
}

/** Presentation stays host-owned even when the optional mention tool is disabled. */
function RecipientAvatars({
  session,
  recipients,
  disabled,
  remove,
}: {
  session: RelaySession;
  recipients: readonly MentionRecipient[];
  disabled: boolean;
  remove(pubkey: string): void;
}) {
  const reduceMotion = useReducedMotion();
  const enter = useCallback(
    (node: HTMLButtonElement | null) => {
      if (
        !node ||
        document.documentElement.hasAttribute("data-keyboard-navigation") ||
        reduceMotion
      )
        return;
      const animation = animate(
        node,
        { transform: ["scale(0.9)", "scale(1)"] },
        { type: "spring", duration: 0.24, bounce: 0.15 },
      );
      return () => animation.stop();
    },
    [reduceMotion],
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const unique = [
    ...new Map(recipients.map((item) => [item.pubkey, item])).values(),
  ];
  return (
    <section
      className={styles.mentionRecipients}
      aria-label="Explicit mentions"
    >
      {unique.map((recipient) => {
        const profile = profiles.get(recipient.pubkey);
        return (
          <IconButton
            key={recipient.pubkey}
            type="button"
            size="toolbar"
            ref={enter}
            data-mention-recipient=""
            data-avatar-shape={
              agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
            }
            title={`Remove explicit mention of ${recipient.name} (${recipient.pubkey.slice(0, 8)})`}
            aria-label={`Remove mention ${recipient.name} ${recipient.pubkey}`}
            disabled={disabled}
            onClick={() => remove(recipient.pubkey)}
            icon={
              <span
                className={styles.mentionRecipientArtwork}
                data-avatar-shape={
                  agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                }
                aria-hidden="true"
              >
                <Avatar
                  alt=""
                  fallback={recipient.name}
                  src={session.media(profile?.picture ?? "", "small")}
                  size="small"
                  shape={
                    agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                  }
                />
                <span className={styles.mentionRecipientRemove}>
                  <XIcon size={16} />
                </span>
              </span>
            }
          />
        );
      })}
    </section>
  );
}
