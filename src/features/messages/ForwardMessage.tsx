import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { BuzzLinkPreview } from "../conversation/BuzzLinkPreview";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { canMessageAgent } from "../agents/choices";
import { RecipientPicker } from "../direct-messages/RecipientPicker";
import type { Recipient } from "../direct-messages/usePeople";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import type { ChannelMessage } from "../relay/contracts";
import { splitPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";
import styles from "./ForwardMessage.module.css";

type Source = Extract<OpenTarget, { kind: "conversation" }> & {
  forward: string;
};
const ForwardMessageContext = createContext<
  ((row: ChannelMessage) => void) | undefined
>(undefined);
export const useForwardMessage = () => useContext(ForwardMessageContext);
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;

export function ForwardMessageProvider({
  session,
  scope,
  navigation,
  renderDialog = false,
  children,
}: {
  session: RelaySession;
  scope: string;
  navigation: Navigation | undefined;
  renderDialog?: boolean;
  children: ReactNode;
}) {
  const active = useConversationPresentation();
  const snapshot = useSyncExternalStore(
    navigation?.subscribe ?? noSubscribe,
    navigation?.snapshot ?? noSnapshot,
  );
  const target = snapshot?.entry.target;
  const parts = splitPartition(scope);
  const requested =
    target?.kind === "conversation" &&
    target.forward &&
    target.scope.viewer === session.viewer &&
    target.scope.communityOrigin === parts?.communityOrigin
      ? (target as Source)
      : undefined;
  const locked = useRef(false);
  const [source, setSource] = useState(requested);
  if (
    requested &&
    !locked.current &&
    (source?.forward !== requested.forward ||
      source.channelId !== requested.channelId)
  )
    setSource(requested);
  const trigger = useRef<HTMLElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  const forward = useCallback(
    (row: ChannelMessage) => {
      const scopeParts = splitPartition(scope);
      if (
        !active ||
        !navigation ||
        !scopeParts ||
        !session.directMessages.available
      )
        return;
      const current = navigation.snapshot().entry.target;
      if (
        locked.current &&
        (row.id !== source?.forward || row.channelId !== source?.channelId)
      ) {
        setBlocked(true);
        return;
      }
      trigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      void navigation.open({
        ...(current.kind === "conversation" &&
        current.channelId === row.channelId
          ? current
          : {}),
        version: 1,
        kind: "conversation",
        scope: scopeParts,
        channelId: row.channelId,
        forward: row.id,
      });
    },
    [active, navigation, scope, session, source],
  );
  const close = (source: Source) => {
    if (!navigation) return;
    const { forward: _forward, ...fallback } = source;
    navigation.dismiss(
      (target) =>
        target.kind === "conversation" &&
        target.forward === source.forward &&
        target.channelId === source.channelId &&
        target.scope.viewer === source.scope.viewer &&
        target.scope.communityOrigin === source.scope.communityOrigin,
      fallback,
    );
  };
  return (
    <ForwardMessageContext
      value={
        navigation && session.directMessages.available ? forward : undefined
      }
    >
      {children}
      {renderDialog && source && navigation && (
        <ForwardMessageDialog
          key={`${source.channelId}:${source.forward}`}
          session={session}
          scope={scope}
          source={source}
          open={
            requested?.forward === source.forward &&
            requested.channelId === source.channelId &&
            active
          }
          close={() => close(source)}
          finalFocus={trigger}
          lock={(value) => {
            locked.current = value;
          }}
        />
      )}
      {blocked && (
        <ToastNotice
          title="Retry the pending forward before forwarding another message."
          tone="info"
          timeout={4000}
          onDismiss={() => setBlocked(false)}
        />
      )}
    </ForwardMessageContext>
  );
}

function ForwardMessageDialog({
  session,
  scope,
  source,
  open,
  close,
  finalFocus,
  lock,
}: {
  session: RelaySession;
  scope: string;
  source: Source;
  open: boolean;
  close(): void;
  finalFocus: React.RefObject<HTMLElement | null>;
  lock(value: boolean): void;
}) {
  const [people, setPeople] = useState<Recipient[]>([]);
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const fields = useRef<HTMLDivElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const operation = useRef<AbortController | undefined>(undefined);
  const sent = useRef<{ id: string; channelId: string } | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), []);
  const person = people[0];
  const locked = pending || !!sent.current;
  const submit = async () => {
    if (!open || !person || typed || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    lock(true);
    setPending(true);
    setError("");
    setNotice(undefined);
    try {
      if (!sent.current) {
        const validateRecipient = () => {
          if (
            (person.isAgent ||
              session.profiles.snapshot().get(person.pubkey)?.isAgent) &&
            !session.agentChoices
              .snapshot()
              .identities.some(
                (choice) =>
                  choice.pubkey === person.pubkey && canMessageAgent(choice),
              )
          )
            throw new Error(
              "This agent is no longer available for direct messages. Choose another person.",
            );
        };
        validateRecipient();
        const channelId = await session.directMessages.open(
          [person.pubkey],
          controller.signal,
        );
        controller.signal.throwIfAborted();
        await session.outbox?.ready();
        controller.signal.throwIfAborted();
        validateRecipient();
        const link = `buzz://message?${new URLSearchParams({ channel: source.channelId, id: source.forward })}`;
        const literalNote = note
          .trim()
          .replace(/[\\`*_{}[\]<>()#+\-.!|~]/g, "\\$&");
        const id = session.messages.send(
          channelId,
          [literalNote, link].filter(Boolean).join("\n\n"),
        );
        sent.current = { id, channelId };
      }
      await session.directMessages.delivered(
        sent.current.id,
        sent.current.channelId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      sent.current = undefined;
      lock(false);
      setPeople([]);
      setNote("");
      close();
      setNotice({ text: `Message forwarded to ${person.name}`, error: false });
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (!sent.current) lock(false);
        const text =
          reason instanceof Error
            ? reason.message
            : "Couldn’t forward the message. Try again.";
        setError(text);
        setNotice({ text, error: true });
      }
    } finally {
      if (!controller.signal.aborted) {
        operation.current = undefined;
        setPending(false);
      }
    }
  };
  return (
    <>
      <Dialog
        open={open}
        title="Forward message"
        description="Send this message to a person, with an optional note."
        preventClose={pending}
        dismissOnOutsideClick={false}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        initialFocus={() =>
          fields.current?.querySelector<HTMLInputElement>(
            '[role="combobox"]',
          ) ?? null
        }
        finalFocus={() =>
          finalFocus.current?.isConnected ? finalFocus.current : false
        }
        actions={
          <>
            <Button disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="prominent"
              loading={pending}
              disabled={pending || !person || typed}
              onClick={() => void submit()}
            >
              {sent.current ? "Retry forward" : "Forward"}
            </Button>
          </>
        }
      >
        <div className={styles.form} ref={fields}>
          <RecipientPicker
            session={session}
            scope={scope}
            selected={people}
            disabled={locked}
            maxRecipients={1}
            initiallyOpen={false}
            onChange={setPeople}
            onTyped={setTyped}
            onComplete={() => noteField.current?.focus()}
          />
          <Field label="Note (optional)">
            <Textarea
              ref={noteField}
              rows={3}
              maxLength={4096}
              value={note}
              disabled={locked}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          {open && (
            <section className={styles.preview} aria-label="Message to forward">
              <BuzzLinkPreview
                session={session}
                channelId={source.channelId}
                messageId={source.forward}
              />
            </section>
          )}
          <p className="text-body-sm text-subtle">
            The recipient can open the original only if they have access to its
            conversation.
          </p>
          {error && (
            <p role="alert" className="text-body-sm text-subtle">
              {error}
            </p>
          )}
        </div>
      </Dialog>
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
    </>
  );
}
