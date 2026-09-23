import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import { MessageComposer } from "../messages/MessageComposer";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { RecipientPicker } from "./RecipientPicker";
import type { Recipient } from "./usePeople";
import styles from "./NewMessage.module.css";

const draftKey = "direct-message:new-draft";
type Pending = {
  id: string;
  channelId: string;
  recipients: string;
  draft: MentionDraft;
};
const keyFor = (people: readonly Recipient[]) =>
  people
    .map((person) => person.pubkey)
    .sort()
    .join(":");
function savedRecipients(scope: string, viewer?: string) {
  const saved = readView<unknown>(scope, "direct-message:recipients", []);
  if (!Array.isArray(saved)) return [];
  return [
    ...new Map(
      saved
        .filter(
          (person): person is Recipient =>
            person &&
            typeof person.pubkey === "string" &&
            /^[0-9a-f]{64}$/.test(person.pubkey) &&
            person.pubkey !== viewer &&
            typeof person.name === "string" &&
            person.name.length <= 500,
        )
        .map((person) => [person.pubkey, person]),
    ).values(),
  ].slice(0, 8);
}
function savedPending(scope: string): Pending | undefined {
  const value = readView<Partial<Pending> | null>(
    scope,
    "direct-message:pending",
    null,
  );
  if (
    value &&
    typeof value.id === "string" &&
    /^[0-9a-f]{64}$/.test(value.id) &&
    typeof value.channelId === "string" &&
    /^[0-9a-f-]{36}$/.test(value.channelId) &&
    typeof value.recipients === "string" &&
    value.recipients.length <= 519 &&
    value.draft
  )
    return {
      id: value.id,
      channelId: value.channelId,
      recipients: value.recipients,
      draft: mentionDraft(value.draft),
    };
}

/** Empty conversation until its first message is confirmed by the regular outbox. */
export function NewMessage({
  session,
  scope,
  extensions,
  onStarted,
}: {
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  onStarted(channelId: string, messageId: string): void;
}) {
  const [recipients, setRecipients] = useState(() =>
    savedRecipients(scope, session.viewer),
  );
  const recipientNames = recipients.map((person) => person.name).join(", ");
  const [pending, setPending] = useState(() => savedPending(scope));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftChannel] = useState(() => crypto.randomUUID());
  const attempt = useRef<AbortController | null>(null);
  const prepared = useRef<{ key: string; id: string } | undefined>(undefined);
  const outbox = session.outbox;
  useSyncExternalStore(
    outbox?.subscribe ?? noSubscribe,
    outbox?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const failed =
    pending && session.directMessages.delivery(pending.id) === "failed";
  const locked = busy || (!!pending && !failed);
  useEffect(() => () => attempt.current?.abort(), []);
  function change(people: Recipient[]) {
    if (locked || attempt.current) return;
    prepared.current = undefined;
    setRecipients(people);
    writeView(scope, "direct-message:recipients", people);
    setError("");
  }
  async function send(draft: MentionDraft) {
    if (
      attempt.current ||
      !recipients.length ||
      !draft.text.trim() ||
      !session.directMessages.available
    )
      return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setError("");
    const key = keyFor(recipients);
    let current = pending;
    try {
      if (
        current &&
        (current.recipients !== key ||
          JSON.stringify(current.draft) !== JSON.stringify(draft))
      ) {
        if (session.directMessages.delivery(current.id) !== "failed")
          throw new Error(
            "Retry the earlier message to confirm its delivery before editing.",
          );
        await outbox?.dismiss(current.id);
        controller.signal.throwIfAborted();
        current = undefined;
        setPending(undefined);
        writeView(scope, "direct-message:pending", null);
      }
      if (!current) {
        const id =
          prepared.current?.key === key
            ? prepared.current.id
            : await session.directMessages.open(
                recipients.map((person) => person.pubkey),
                controller.signal,
              );
        controller.signal.throwIfAborted();
        prepared.current = { key, id };
        const messageId = session.messages.send(
          id,
          draft.text,
          draft.recipients.map((person) => person.pubkey),
        );
        current = { id: messageId, channelId: id, recipients: key, draft };
        setPending(current);
        writeView(scope, "direct-message:pending", current);
      }
      await session.directMessages.delivered(
        current.id,
        current.channelId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      writeView(scope, "direct-message:pending", null);
      writeView(scope, "direct-message:recipients", []);
      writeView(scope, draftKey, "");
      onStarted(current.channelId, current.id);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not send your message. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (attempt.current === controller) attempt.current = null;
    }
  }
  return (
    <section className={styles.page} aria-label="New message">
      <RecipientPicker
        session={session}
        scope={scope}
        selected={recipients}
        disabled={locked}
        onChange={change}
      />
      <div className={styles.blank} data-new-message-body="" />
      <div className={styles.feedback}>
        {busy && <p role="status">Sending message…</p>}
        {!session.directMessages.available && (
          <p role="status">
            Starting direct messages is unavailable on this connection.
          </p>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {pending && !failed && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void send(pending.draft)}
              >
                Retry send
              </Button>
            )}
          </div>
        )}
      </div>
      <MessageComposer
        session={session}
        scope={scope}
        extensions={extensions}
        channelId={draftChannel}
        channelName={recipientNames || "new message"}
        label={recipientNames ? `Message ${recipientNames}` : "New message"}
        placeholder={recipientNames ? undefined : ""}
        disabled={!recipients.length}
        submission={{
          draftKey,
          initialDraft: pending?.draft,
          locked,
          disabled:
            busy || !recipients.length || !session.directMessages.available,
          submit: (draft) => void send(draft),
        }}
      />
    </section>
  );
}
const empty: readonly never[] = [];
const emptySnapshot = () => empty;
const noSubscribe = () => () => {};
