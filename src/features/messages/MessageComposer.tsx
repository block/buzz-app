import { ArrowUp, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import {
  mentionDraft,
  editMentionDraft,
  replaceMentionDraft,
  type MentionDraft,
  type MentionEdit,
  type MentionRecipient,
} from "./mention-draft";
import { ComposerTools } from "../conversation/ComposerTools";
import type { ConversationExtensions } from "../conversation/contracts";

export type MessageComposerProps = {
  extensions?: ConversationExtensions | undefined;
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
  extensions,
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
  const valueRef = useRef(value);
  const caret = useRef<number | undefined>(undefined);
  const saveDraft = (next: MentionDraft) => {
    valueRef.current = next;
    updateDraft(next);
    writeView(scope, draftKey, next);
  };
  const setDraft = (text: string) =>
    saveDraft(editMentionDraft(valueRef.current, text));
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
  useLayoutEffect(() => {
    if (caret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  function insert(text: string, recipient?: MentionRecipient) {
    if (
      disabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      // DOM props are committed before child layout effects; closures can still
      // carry the preceding render's enabled state during that interval.
      input.current.disabled ||
      typeof text !== "string"
    )
      return false;
    const current = valueRef.current;
    const start = caret.current ?? input.current.selectionStart;
    const end = caret.current ?? input.current.selectionEnd;
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
          {extensions && (
            <ComposerTools
              registry={extensions.tools}
              session={session}
              scope={scope}
              channelId={channelId}
              threadRootId={threadRootId}
              disabled={disabled}
              insertText={(text) => insert(text)}
              insertMention={insertMention}
              focus={() => input.current?.focus()}
            />
          )}
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
      {error && session.emoji?.snapshot().status === "error" && (
        <button
          type="button"
          disabled={disabled}
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
  );
}
