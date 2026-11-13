import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { agentUnavailable, canMessageAgent } from "../agents/choices";
import { channelText } from "../channels/channel-icon";
import { RecipientPicker } from "../direct-messages/RecipientPicker";
import type { Recipient } from "../direct-messages/usePeople";
import {
  useVerifiedNames,
  withVerifiedNames,
} from "../profiles/useVerifiedNames";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
import type { OutgoingEvent } from "../relay/outbox";
import { splitPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";
import styles from "./ForwardMessage.module.css";

type Source = Extract<OpenTarget, { kind: "conversation" }> & {
  forward: string;
};
const ForwardMessageContext = createContext<
  ((row: ChannelMessage) => void) | undefined
>(undefined);
/** Set by the provider that renders the dialog and owns pending forwards. */
const ForwardOwnerContext = createContext(false);
export const useForwardMessage = () => useContext(ForwardMessageContext);
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;
const emptyOperations: readonly OutgoingEvent[] = [];
const noOperations = () => emptyOperations;

const recoveryKey = "message:forward";
const hex64 = /^[0-9a-f]{64}$/;
/** A person's DM, or a channel the viewer can post in. */
type ForwardTarget =
  | { kind: "person"; person: Recipient }
  | {
      kind: "channel";
      channel: { id: string; name: string; private?: true };
    };
type PendingForward = {
  id: string;
  channelId: string;
  source: { channelId: string; forward: string };
  target: ForwardTarget;
  note: string;
};
/** Channels a forward can post into: current, writable, ordinary conversations. */
const forwardChannel = (channel: ChannelSummary) =>
  (channel.channelType === "stream" || channel.channelType === "forum") &&
  !channel.huddle &&
  !channel.metadataPending &&
  !channel.pending &&
  !channel.cached &&
  !channel.readOnly &&
  !channel.archived;
const targetName = (target: ForwardTarget) =>
  target.kind === "person"
    ? target.person.name
    : channelText({ ...target.channel, channelType: "stream" });
// The durable outbox, not component state, owns an uncertain forward: a reload
// must restore and confirm the original event rather than publish another.
function pendingForward(
  operations: readonly OutgoingEvent[],
  viewer: string | undefined,
): PendingForward | undefined {
  for (const item of operations) {
    if (item.recovery?.key !== recoveryKey || item.event.kind !== 9) continue;
    const channelId = item.event.tags.find(([name]) => name === "h")?.[1];
    try {
      const { source, person, channel, note } = JSON.parse(item.recovery.value);
      if (
        !channelId ||
        typeof source?.channelId !== "string" ||
        !source.channelId ||
        typeof source.forward !== "string" ||
        !hex64.test(source.forward) ||
        typeof note !== "string"
      )
        continue;
      const target: ForwardTarget | undefined =
        typeof person?.pubkey === "string" &&
        hex64.test(person.pubkey) &&
        person.pubkey !== viewer &&
        typeof person.name === "string"
          ? {
              kind: "person",
              person: {
                pubkey: person.pubkey,
                name: person.name.slice(0, 500),
                ...(person.isAgent === true ? { isAgent: true } : {}),
              },
            }
          : channel?.id === channelId && typeof channel.name === "string"
            ? {
                kind: "channel",
                channel: {
                  id: channelId,
                  name: channel.name.slice(0, 500),
                  ...(channel.private === true ? { private: true } : {}),
                },
              }
            : undefined;
      if (target)
        return {
          id: item.event.id,
          channelId,
          source: { channelId: source.channelId, forward: source.forward },
          target,
          note: note.slice(0, 4096),
        };
    } catch {
      /* An unreadable payload stays visible in the outbox for removal. */
    }
  }
}
const isPendingSource = (
  pending: PendingForward,
  target: { channelId: string; forward?: string | undefined },
) =>
  target.forward === pending.source.forward &&
  target.channelId === pending.source.channelId;

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
  // Hosted conversations nest beneath the dialog's owner. Delegate to it so
  // one provider holds the source, the pending guard and the retry notice.
  const owned = useContext(ForwardOwnerContext);
  const ownerForward = useContext(ForwardMessageContext);
  const delegate = owned && !renderDialog;
  const operations = useSyncExternalStore(
    session.outbox?.subscribe ?? noSubscribe,
    session.outbox?.snapshot ?? noOperations,
    noOperations,
  );
  const pending = pendingForward(operations, session.viewer);
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
    (!pending || isPendingSource(pending, requested)) &&
    (source?.forward !== requested.forward ||
      source.channelId !== requested.channelId)
  )
    setSource(requested);
  const trigger = useRef<HTMLElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  const open = useCallback(
    (channelId: string, id: string) => {
      const scopeParts = splitPartition(scope);
      if (!navigation || !scopeParts) return;
      const current = navigation.snapshot().entry.target;
      trigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      void navigation.open({
        ...(current.kind === "conversation" && current.channelId === channelId
          ? current
          : {}),
        version: 1,
        kind: "conversation",
        scope: scopeParts,
        channelId,
        forward: id,
      });
    },
    [navigation, scope],
  );
  const forward = useCallback(
    (row: ChannelMessage) => {
      if (!active || !session.directMessages.available) return;
      const target = { channelId: row.channelId, forward: row.id };
      if (
        (locked.current &&
          (row.id !== source?.forward ||
            row.channelId !== source?.channelId)) ||
        (pending && !isPendingSource(pending, target))
      ) {
        setBlocked(true);
        return;
      }
      open(row.channelId, row.id);
    },
    [active, open, pending, session, source],
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
    <ForwardOwnerContext value={owned || renderDialog}>
      <ForwardMessageContext
        value={
          delegate
            ? ownerForward
            : navigation && session.directMessages.available
              ? forward
              : undefined
        }
      >
        {children}
        {renderDialog && source && navigation && (
          <ForwardMessageDialog
            key={`${source.channelId}:${source.forward}`}
            session={session}
            scope={scope}
            navigation={navigation}
            source={source}
            recovered={
              pending && isPendingSource(pending, source) ? pending : undefined
            }
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
        {blocked && !delegate && (
          <ToastNotice
            title="Retry the pending forward before forwarding another message."
            tone="info"
            timeout={pending ? 0 : 4000}
            onDismiss={() => setBlocked(false)}
          >
            {pending && (
              <Button
                onClick={() => {
                  setBlocked(false);
                  open(pending.source.channelId, pending.source.forward);
                }}
              >
                Review pending forward
              </Button>
            )}
          </ToastNotice>
        )}
      </ForwardMessageContext>
    </ForwardOwnerContext>
  );
}

function ForwardMessageDialog({
  session,
  scope,
  navigation,
  source,
  recovered,
  open,
  close,
  finalFocus,
  lock,
}: {
  session: RelaySession;
  scope: string;
  navigation: Navigation;
  source: Source;
  recovered: PendingForward | undefined;
  open: boolean;
  close(): void;
  finalFocus: React.RefObject<HTMLElement | null>;
  lock(value: boolean): void;
}) {
  const recoveredPeople = (pending?: PendingForward) =>
    pending?.target.kind === "person" ? [pending.target.person] : [];
  const recoveredChannel = (pending?: PendingForward) =>
    pending?.target.kind === "channel" ? pending.target.channel.id : "";
  const [people, setPeople] = useState<Recipient[]>(() =>
    recoveredPeople(recovered),
  );
  const [channelId, setChannelId] = useState(() => recoveredChannel(recovered));
  const [note, setNote] = useState(() => recovered?.note ?? "");
  const restored = useRef(recovered?.id);
  // The outbox can finish loading after the dialog mounts.
  if (recovered && restored.current !== recovered.id) {
    restored.current = recovered.id;
    setPeople(recoveredPeople(recovered));
    setChannelId(recoveredChannel(recovered));
    setNote(recovered.note);
  }
  const channelList = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channels = useMemo(
    () => channelList.channels.filter(forwardChannel),
    [channelList],
  );
  const [typed, setTyped] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{
    text: string;
    error: boolean;
    navigation?: { label: string; open(): void };
  }>();
  const fields = useRef<HTMLDivElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), []);
  // Labels follow current verification, then the current profile name.
  const verified = useVerifiedNames(session, people);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const named = useMemo(
    () =>
      withVerifiedNames(
        people.map((person) => {
          const current = profiles.get(person.pubkey);
          return current && !current.verified
            ? { ...person, name: current.name }
            : person;
        }),
        verified,
        profiles,
      ),
    [people, verified, profiles],
  );
  const person = people[0];
  const channel = channels.find((item) => item.id === channelId);
  // A recovered channel keeps its saved label until the list names it.
  const target: ForwardTarget | undefined = person
    ? { kind: "person", person }
    : channel
      ? {
          kind: "channel",
          channel: {
            id: channel.id,
            name: channel.name,
            ...(channel.private ? { private: true } : {}),
          },
        }
      : recovered?.target.kind === "channel" &&
          recovered.target.channel.id === channelId
        ? recovered.target
        : undefined;
  const locked = pending || !!recovered;
  const submit = async () => {
    if (!open || !target || typed || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    lock(true);
    setPending(true);
    setError("");
    setNotice(undefined);
    try {
      // The confirmed record names its destination: the outbox can turn up a
      // saved forward to somewhere other than the one picked.
      let sent:
        | Pick<PendingForward, "id" | "channelId" | "target">
        | undefined = recovered;
      if (!sent) {
        const validateRecipient = () => {
          if (target.kind !== "person") return;
          const { person } = target;
          if (
            agentUnavailable(session, person.pubkey) ||
            ((person.isAgent ||
              session.profiles.snapshot().get(person.pubkey)?.isAgent) &&
              !session.agentChoices
                .snapshot()
                .identities.some(
                  (choice) =>
                    choice.pubkey === person.pubkey && canMessageAgent(choice),
                ))
          )
            throw new Error(
              "This agent is no longer available for direct messages. Choose another person.",
            );
        };
        validateRecipient();
        // A channel is posted to directly; sending checks write access.
        const channelId =
          target.kind === "person"
            ? await session.directMessages.open(
                [target.person.pubkey],
                controller.signal,
              )
            : target.channel.id;
        controller.signal.throwIfAborted();
        await session.outbox?.ready();
        controller.signal.throwIfAborted();
        const saved = pendingForward(
          session.outbox?.snapshot() ?? [],
          session.viewer,
        );
        if (saved && !isPendingSource(saved, source))
          throw new Error(
            "Retry the pending forward before forwarding another message.",
          );
        validateRecipient();
        const link = `buzz://message?${new URLSearchParams({ channel: source.channelId, id: source.forward })}`;
        const literalNote = note
          .trim()
          .replace(/[\\`*_{}[\]<>()#+\-.!|~]/g, "\\$&");
        sent = saved ?? {
          id: session.messages.send(
            channelId,
            [literalNote, link].filter(Boolean).join("\n\n"),
            [],
            [],
            {
              key: recoveryKey,
              value: JSON.stringify({
                source: {
                  channelId: source.channelId,
                  forward: source.forward,
                },
                ...(target.kind === "person"
                  ? {
                      person: {
                        pubkey: target.person.pubkey,
                        name: target.person.name.slice(0, 500),
                        ...(target.person.isAgent === true
                          ? { isAgent: true }
                          : {}),
                      },
                    }
                  : {
                      channel: {
                        id: target.channel.id,
                        name: target.channel.name.slice(0, 500),
                        ...(target.channel.private ? { private: true } : {}),
                      },
                    }),
                note,
              }),
            },
          ),
          channelId,
          target,
        };
      }
      await session.directMessages.delivered(
        sent.id,
        sent.channelId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      // Releasing recovery is the last step: until then a retry only confirms.
      await session.outbox?.acknowledge(sent.id);
      controller.signal.throwIfAborted();
      lock(false);
      setPeople([]);
      setChannelId("");
      setNote("");
      close();
      const { id, channelId, target: to } = sent;
      // You stay where you forwarded from; the notice opens what you sent.
      setNotice({
        text: `Message forwarded to ${targetName(to)}`,
        error: false,
        navigation: {
          label:
            to.kind === "person"
              ? `Open your DM with ${to.person.name}`
              : `Open ${targetName(to)}`,
          open: () => {
            setNotice(undefined);
            void navigation.open({
              version: 1,
              kind: "conversation",
              scope: source.scope,
              channelId,
              messageId: id,
            });
          },
        },
      });
    } catch (reason) {
      if (!controller.signal.aborted) {
        // A sent forward stays locked by its outbox recovery.
        lock(false);
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
        description="Send this message to a person or channel, with an optional note."
        headerGap="compact"
        footerGap="compact"
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
              disabled={pending || !target || typed}
              onClick={() => void submit()}
            >
              {recovered ? "Retry forward" : "Forward"}
            </Button>
          </>
        }
      >
        <div className={styles.form} ref={fields}>
          <RecipientPicker
            session={session}
            scope={scope}
            selected={people}
            labels={named}
            disabled={locked}
            maxRecipients={1}
            appearance="field"
            initiallyOpen={false}
            channels={channels}
            channel={target?.kind === "channel" ? target.channel : undefined}
            onChannel={(item) => setChannelId(item?.id ?? "")}
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
            Recipients can open the original only if they have access to its
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
          navigation={notice.navigation}
        />
      )}
    </>
  );
}
