import { ArrowUp, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import { MentionPicker } from "./MentionPicker";
import {
  mentionDraft,
  editMentionDraft,
  replaceMentionDraft,
  type MentionDraft,
  type MentionEdit,
  type MentionRecipient,
} from "./mention-draft";
import { EmojiPicker } from "./EmojiPicker";

type MessageComposerProps = {
  scope: string;
  session: RelaySession;
  channelId: string;
  channelName: string;
  onSend?: (id: string) => void;
  threadRootId?: string;
  disabled?: boolean;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function MessageComposer(props: MessageComposerProps) {
  return (
    <Composer
      key={messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.threadRootId,
      )}
      {...props}
    />
  );
}
function Composer({
  session,
  scope,
  channelId,
  channelName,
  onSend,
  threadRootId,
  disabled = false,
}: MessageComposerProps) {
  const inputId = useId();
  const draftKey = threadRootId
    ? `draft:${channelId}:thread:${threadRootId}`
    : `draft:${channelId}`;
  const label = threadRootId ? "Reply to thread" : `Message #${channelName}`;
  const [value, updateDraft] = useState(() =>
    mentionDraft(readView<unknown>(scope, draftKey, "")),
  );
  const draft = value.text;
  const saveDraft = (next: MentionDraft) => {
    updateDraft(next);
    writeView(scope, draftKey, next);
  };
  const setDraft = (text: string) => saveDraft(editMentionDraft(value, text));
  const [error, setError] = useState<string>();
  const outbox = session.outbox;
  const input = useRef<HTMLTextAreaElement>(null);
  const edit = useRef<MentionEdit | undefined>(undefined);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const capture = (event: InputEvent) => {
      edit.current = {
        text: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
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
  function insertEmoji(text: string) {
    const start = input.current?.selectionStart ?? draft.length;
    const end = input.current?.selectionEnd ?? start;
    const next = draft.slice(0, start) + text + draft.slice(end);
    if (next.length > 16000) {
      setError("Message is too long to insert emoji");
      return;
    }
    saveDraft(replaceMentionDraft(value, start, end, text));
    setError(undefined);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(
        start + text.length,
        start + text.length,
      );
    });
  }
  function insertMention(recipient: MentionRecipient) {
    if (value.recipients.length >= 32) {
      setError("Choose at most 32 recipients");
      return;
    }
    const start = input.current?.selectionStart ?? draft.length;
    const end = input.current?.selectionEnd ?? start;
    const token = `@${recipient.name} `;
    const text = draft.slice(0, start) + token + draft.slice(end);
    if (text.length > 16000) {
      setError("Message is too long to insert a mention");
      return;
    }
    const edited = replaceMentionDraft(value, start, end, token);
    saveDraft(
      mentionDraft({
        text,
        recipients: [
          ...edited.recipients,
          { ...recipient, start, end: start + token.length - 1 },
        ],
      }),
    );
    setError(undefined);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(
        start + token.length,
        start + token.length,
      );
    });
  }
  function send() {
    if (disabled || !draft.trim() || !outbox) return;
    try {
      const id = threadRootId
        ? session.messages.reply(
            channelId,
            threadRootId,
            draft,
            value.recipients.map((item) => item.pubkey),
          )
        : session.messages.send(
            channelId,
            draft,
            value.recipients.map((item) => item.pubkey),
          );
      onSend?.(id);
      setDraft("");
      input.current?.focus();
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  if (!outbox?.supports(9))
    return (
      <footer className={styles.composer}>
        This relay connection supports reading only.
      </footer>
    );
  return (
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
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        ref={input}
        id={inputId}
        disabled={disabled}
        value={draft}
        maxLength={16000}
        rows={2}
        placeholder={label}
        // onInput also observes same-text replacements, which onChange omits.
        onChange={() => {}}
        onInput={(event) => {
          const range = edit.current;
          edit.current = undefined;
          saveDraft(editMentionDraft(value, event.currentTarget.value, range));
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            send();
          }
        }}
      />
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
              <X size={12} aria-hidden="true" />
            </button>
          ))}
        </section>
      )}
      <div className={styles.composerActions}>
        <div className={styles.composerTools}>
          <MentionPicker
            session={session}
            channelId={channelId}
            disabled={disabled}
            select={insertMention}
          />
          <EmojiPicker
            session={session}
            scope={scope}
            disabled={disabled}
            insert={insertEmoji}
          />
        </div>
        <span className={styles.composerHint}>
          Shift + Enter for a new line
        </span>
        <button
          className={styles.sendButton}
          type="submit"
          aria-label="Send message"
          title="Send message"
          disabled={disabled || !draft.trim()}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
