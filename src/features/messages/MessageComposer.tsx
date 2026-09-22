import { useMentionAgents } from "../agents/mention-context";
import { enrollMentionedAgents } from "../agents/mention-enrollment";
import { SessionAgentControl } from "../sessions/SessionAgentControl";
import { sessionRecipients } from "../sessions/recipients";
import { TypingIndicator } from "./TypingIndicator";
import { ArrowUpIcon, XIcon } from "../../shared/design-system/icons/index";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import { extendEmojiSelection } from "./emoji-selection";
import {
  customEmojiOnlySpans,
  isEmojiOnly,
  leadingCustomEmojiSpans,
  usesLargeEmojiPresentation,
} from "./emoji-size";
import {
  mentionDraft,
  editMentionDraft,
  replaceMentionDraft,
  type MentionDraft,
  type MentionEdit,
  type MentionRecipient,
} from "./mention-draft";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import { ComposerTools } from "../conversation/ComposerTools";
import type {
  ConversationExtensions,
  CompletionEdit,
  CompletionQuery,
  ComposerObservation,
} from "../conversation/contracts";
import { ComposerCompletions } from "../conversation/ComposerCompletions";
import { useCompletionEditor } from "../conversation/useCompletionEditor";
import { formatMediaTime, mediaTimeReply } from "./media-timecode";
import { RichComposerInput } from "./RichComposerInput";
import { sourceOffset, type ComposerInputElement } from "./composer-dom";

const noChannels: ReturnType<RelaySession["channels"]["list"]> = {
  status: "idle",
  channels: [],
};
const noChannelSnapshot = () => noChannels;
const noChannelSubscription = () => () => {};

export type MessageComposerProps = {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  session: RelaySession;
  channelId: string;
  channelName: string;
  label?: string | undefined;
  sessionConversation?: boolean | undefined;
  trailingTool?: ReactNode;
  inviteAgents?: boolean | undefined;
  onSend?: (id: string) => void;
  onOpenLink?: ((target: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  threadRootId?: string;
  mediaTimeSeconds?: number;
  clearMediaTime?(): void;
  hideMediaTimeIndicator?: boolean;
  disabled?: boolean;
  /** A new conversation owns persistence and delivery before a channel exists. */
  submission?: {
    draftKey: string;
    initialDraft?: MentionDraft | string | undefined;
    locked: boolean;
    disabled: boolean;
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
  onSend,
  onOpenLink,
  canOpenLink,
  threadRootId,
  mediaTimeSeconds,
  clearMediaTime,
  hideMediaTimeIndicator = false,
  disabled = false,
  submission,
  sessionConversation,
  inviteAgents = false,
  trailingTool,
}: MessageComposerProps) {
  const { control } = useMentionAgents(scope);
  const [sending, setSending] = useState(false);
  const sendAttempt = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => sendAttempt.current?.abort(), []);
  useLayoutEffect(() => {
    if (disabled) sendAttempt.current?.abort();
  }, [disabled]);
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
  permitted.current = !disabled;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const list = useSyncExternalStore(
    sessionConversation
      ? session.channels.subscribeList
      : noChannelSubscription,
    sessionConversation ? session.channels.list : noChannelSnapshot,
    sessionConversation ? session.channels.list : noChannelSnapshot,
  );
  const parentChannelId = list.channels.find(
    (item) => item.id === channelId,
  )?.parentChannelId;
  const agentChoices = inviteAgents || !!sessionConversation;
  const editingDisabled =
    disabled || admitting || sending || !!submission?.locked;
  const label =
    customLabel ??
    (threadRootId ? "Reply to thread" : `Message #${channelName}`);
  const [value, updateDraft] = useState(() =>
    mentionDraft(
      readView<unknown>(scope, draftKey, submission?.initialDraft ?? ""),
    ),
  );
  const draft = value.text;
  const valueRef = useRef(value);
  const caret = useRef<number | undefined>(undefined);
  const input = useRef<ComposerInputElement>(null);
  const restoreSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const compositionSaved = useRef(false);
  const history = useRef<{
    past: { draft: MentionDraft; start: number; end: number }[];
    future: { draft: MentionDraft; start: number; end: number }[];
  }>({ past: [], future: [] });
  const saveDraft = (
    next: MentionDraft,
    before?: { start: number; end: number },
  ) => {
    if (
      next.text === valueRef.current.text &&
      JSON.stringify(next.recipients) ===
        JSON.stringify(valueRef.current.recipients)
    )
      return;
    if (!compositionSaved.current)
      history.current.past.push({
        draft: valueRef.current,
        start: before?.start ?? input.current?.selectionStart ?? 0,
        end: before?.end ?? input.current?.selectionEnd ?? 0,
      });
    if (completion.composing.current) compositionSaved.current = true;
    history.current.past = history.current.past.slice(-100);
    history.current.future = [];
    valueRef.current = next;
    updateDraft(next);
    writeView(scope, draftKey, next);
  };
  const setDraft = (text: string) =>
    saveDraft(editMentionDraft(valueRef.current, text));
  const [error, setError] = useState<string>();
  const outbox = session.outbox;
  const emojiCatalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const customEmojiOnly = customEmojiOnlySpans(draft, emojiCatalog.entries);
  const customEmojiSpans = (
    customEmojiOnly.length
      ? customEmojiOnly
      : leadingCustomEmojiSpans(draft, emojiCatalog.entries).spans
  ).filter(({ emoji }) => !!session.media(emoji.url));
  const largeEmojiDraft = usesLargeEmojiPresentation(
    draft,
    emojiCatalog.entries,
  );
  const edit = useRef<MentionEdit | undefined>(undefined);
  const completion = useCompletionEditor(
    input,
    !editingDisabled && !!outbox?.supports(9),
  );
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const capture = (event: InputEvent) => {
      const target = event.getTargetRanges?.()[0];
      const targeted =
        target &&
        element.contains(target.startContainer) &&
        element.contains(target.endContainer);
      // Smart punctuation/autocorrect can replace text behind the caret.
      // Only the browser's target range identifies which spans were touched.
      edit.current = {
        text: element.value,
        start: targeted
          ? sourceOffset(element, target.startContainer, target.startOffset)
          : element.selectionStart,
        end: targeted
          ? sourceOffset(element, target.endContainer, target.endOffset)
          : element.selectionEnd,
        inputType: event.isComposing
          ? "insertCompositionText"
          : event.inputType,
      };
    };
    element.addEventListener("beforeinput", capture);
    return () => element.removeEventListener("beforeinput", capture);
  }, []);
  useEffect(() => {
    if (outbox?.supports(9)) void session.emoji.ensure();
  }, [session, outbox]);
  useLayoutEffect(() => {
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
  function undo(redo: boolean) {
    const owner = input.current?.richComposer;
    if (owner) {
      if (
        editingDisabled ||
        !owner.editor.isEditable ||
        completion.composing.current
      )
        return;
      if (redo) owner.editor.commands.redo();
      else owner.editor.commands.undo();
      completion.invalidate();
      return;
    }
    if (
      editingDisabled ||
      input.current?.readOnly ||
      completion.composing.current
    )
      return;
    const source = redo ? history.current.future : history.current.past;
    const destination = redo ? history.current.past : history.current.future;
    const next = source.pop();
    if (!next) return;
    destination.push({
      draft: valueRef.current,
      start: input.current?.selectionStart ?? 0,
      end: input.current?.selectionEnd ?? 0,
    });
    valueRef.current = next.draft;
    updateDraft(next.draft);
    writeView(scope, draftKey, next.draft);
    caret.current = undefined;
    restoreSelection.current = { start: next.start, end: next.end };
    completion.invalidate();
  }
  function insert(
    text: string,
    recipient?: MentionRecipient,
    range?: CompletionQuery,
  ) {
    const element = input.current;
    if (
      editingDisabled ||
      !outbox?.supports(9) ||
      !element?.isConnected ||
      element.disabled ||
      element.readOnly ||
      typeof text !== "string"
    )
      return false;
    const owner = element.richComposer;
    if (owner) {
      if (recipient) {
        if (range && !owner.setEditingSelection(range.start, range.end))
          return false;
        return owner.insertMention(recipient.pubkey, recipient.name);
      }
      const observation = owner.observation();
      if (!observation) return false;
      return owner.replaceEditingRange(
        observation,
        range?.start ?? observation.start,
        range?.end ?? observation.end,
        text,
      );
    }
    const current = valueRef.current;
    const start = range?.start ?? caret.current ?? element.selectionStart;
    const end = range?.end ?? caret.current ?? element.selectionEnd;
    const edited = replaceMentionDraft(current, start, end, text);
    if (edited.text.length > 16000) {
      setError("Message is too long to insert text");
      return false;
    }
    if (recipient && edited.recipients.length >= 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    const next = recipient
      ? mentionDraft({
          text: edited.text,
          recipients: [
            ...edited.recipients,
            { ...recipient, start, end: start + text.length - 1 },
          ],
        })
      : edited;
    completion.invalidate();
    caret.current = start + text.length;
    saveDraft(next);
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
  function replaceCompletion(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
  ) {
    if (
      !completion.valid(observation) ||
      valueRef.current.text !== observation.text
    )
      return false;
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
        session.agentLibrary.snapshot(),
        session.viewer,
        explicit,
      ),
    ];
    const missing = recipients.filter((key) => !channel.members?.includes(key));
    if (missing.length) {
      await session.agentLibrary.refresh();
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
    if (disabled || admission.current) return;
    setSelectedAgent(key);
    setError(undefined);
  }
  async function send() {
    if (
      disabled ||
      admission.current ||
      submission?.disabled ||
      (!submission && (input.current?.readOnly || input.current?.disabled)) ||
      !draft.trim() ||
      sendAttempt.current ||
      !outbox
    )
      return;
    const attempt = new AbortController();
    sendAttempt.current = attempt;
    const captured = valueRef.current;
    try {
      if (submission) {
        submission.submit(captured);
        return;
      }
      let recipients = captured.recipients.length
        ? captured.recipients.map((item) => item.pubkey)
        : selectedAgent
          ? [selectedAgent]
          : [];
      if (sessionConversation) {
        admission.current = true;
        setAdmitting(true);
        recipients = await prepareRecipients(recipients);
      } else if (control && recipients.length) {
        const members = session.channels
          .list()
          .channels.find((item) => item.id === channelId)?.members;
        if (recipients.some((key) => !members?.includes(key))) {
          setSending(true);
          setError(undefined);
          await enrollMentionedAgents(
            session,
            scope,
            channelId,
            recipients,
            control,
            attempt.signal,
          );
        }
      }
      attempt.signal.throwIfAborted();
      if (valueRef.current !== captured) return;
      const content =
        threadRootId && mediaTimeSeconds !== undefined
          ? mediaTimeReply(mediaTimeSeconds, captured.text)
          : captured.text;
      const id = threadRootId
        ? session.messages.reply(channelId, threadRootId, content, recipients)
        : session.messages.send(channelId, content, recipients);
      onSend?.(id);
      completion.invalidate();
      clearMediaTime?.();
      setDraft("");
      input.current?.richComposer?.restore(mentionDraft(""));
      history.current = { past: [], future: [] };
      input.current?.focus();
      setError(undefined);
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
  const accessories = extensions?.accessories && (
    <ComposerAccessories
      registry={extensions.accessories}
      session={session}
      scope={scope}
      channelId={channelId}
      threadRootId={threadRootId}
      canOpen={(target) => canOpenLink?.(target) ?? false}
      open={(target) => onOpenLink?.(target) ?? false}
    />
  );
  if (!outbox?.supports(9))
    return (
      <>
        {accessories}
        <footer className={styles.composer}>
          <TypingIndicator
            session={session}
            channelId={channelId}
            threadRootId={threadRootId}
          />
          This relay connection supports reading only.
        </footer>
      </>
    );
  return (
    <>
      {accessories}
      <form
        className={styles.composer}
        aria-label={
          threadRootId ? "Reply to thread" : `Send a message to ${channelName}`
        }
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {!disabled && !submission && (
          <TypingIndicator
            session={session}
            channelId={channelId}
            threadRootId={threadRootId}
          />
        )}
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        {extensions?.completions && (
          <ComposerCompletions
            registry={extensions.completions}
            editor={completion}
            input={input}
            session={session}
            scope={scope}
            channelId={channelId}
            threadRootId={threadRootId}
            inviteAgents={agentChoices}
            replace={replaceCompletion}
          />
        )}
        {sending && <p role="status">Adding agent to this channel…</p>}
        <div className={styles.composerInput}>
          <RichComposerInput
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
            onUndo={undo}
            data-single-emoji={largeEmojiDraft || undefined}
            maxLength={16000}
            placeholder={label}
            onFocus={() => completion.observe(true)}
            onBlur={() => {
              completion.invalidate();
            }}
            onSelect={() => {
              completion.observe();
            }}
            onCompositionStart={() => {
              compositionSaved.current = false;
              completion.composing.current = true;
              completion.invalidate();
            }}
            onCompositionEnd={() => {
              compositionSaved.current = false;
              completion.composing.current = false;
              completion.observe(true);
            }}
            onInput={() => {
              const owner = input.current?.richComposer;
              if (!owner) return;
              const next = owner.snapshot().draft;
              valueRef.current = next;
              updateDraft(next);
              writeView(scope, draftKey, next);
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
                if (
                  customEmojiSpans.length &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  (event.key === "ArrowLeft" || event.key === "ArrowRight")
                ) {
                  const next = extendEmojiSelection(
                    customEmojiSpans,
                    event.currentTarget,
                    event.key,
                  );
                  if (next) {
                    event.preventDefault();
                    event.currentTarget.setSelectionRange(
                      next.start,
                      next.end,
                      next.direction,
                    );
                  }
                }
                return;
              }
              if (completion.keys.current?.(event)) return;
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>
        {threadRootId &&
          mediaTimeSeconds !== undefined &&
          !hideMediaTimeIndicator && (
            <div className={styles.mediaComposerAnchor}>
              <span>Commenting at {formatMediaTime(mediaTimeSeconds)}</span>
              <button
                type="button"
                onClick={clearMediaTime}
                aria-label="Remove video time"
              >
                <XIcon size={13} aria-hidden="true" />
              </button>
            </div>
          )}
        {!!value.recipients.length && (
          <section
            className={styles.mentionRecipients}
            aria-label="Notification recipients"
          >
            <span>Notify:</span>
            {value.recipients.map((recipient) => (
              <button
                type="button"
                key={`${recipient.pubkey}:${recipient.start}`}
                title={recipient.pubkey}
                aria-label={`Remove mention ${recipient.name} ${recipient.pubkey}`}
                disabled={editingDisabled}
                onClick={() =>
                  saveDraft({
                    ...value,
                    recipients: value.recipients.filter(
                      (item) => item.pubkey !== recipient.pubkey,
                    ),
                  })
                }
              >
                {recipient.name} <code>{recipient.pubkey.slice(0, 8)}</code>
                <XIcon size={12} aria-hidden="true" />
              </button>
            ))}
          </section>
        )}
        <div className={styles.composerActions}>
          <div className={styles.composerTools}>
            {extensions && (
              <ComposerTools
                registry={extensions.tools}
                session={session}
                scope={scope}
                channelId={channelId}
                threadRootId={threadRootId}
                disabled={editingDisabled}
                inviteAgents={agentChoices}
                insertText={(text) => insert(text)}
                insertMention={insertMention}
                focus={() => input.current?.focus()}
              />
            )}
          </div>
          {trailingTool ??
            (sessionConversation ? (
              <SessionAgentControl
                session={session}
                channelId={channelId}
                value={selectedAgent}
                onChange={selectAgent}
                disabled={editingDisabled}
              />
            ) : (
              <span className={styles.composerHint}>
                Shift + Enter for a new line
              </span>
            ))}
          <button
            className={styles.sendButton}
            type="submit"
            aria-label="Send message"
            title="Send message"
            disabled={
              disabled ||
              admitting ||
              sending ||
              submission?.disabled ||
              !draft.trim()
            }
          >
            <ArrowUpIcon size={18} aria-hidden="true" />
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {error && session.emoji?.snapshot().status === "error" && (
          <button
            type="button"
            disabled={editingDisabled}
            onClick={() => {
              void session.emoji.refresh().then(() => {
                if (
                  input.current?.isConnected &&
                  session.emoji.snapshot().status === "ready"
                )
                  setError(undefined);
              });
            }}
          >
            Retry message preparation
          </button>
        )}
      </form>
    </>
  );
}
