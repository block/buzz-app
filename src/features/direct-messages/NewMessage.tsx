import { hostComposerProvenance } from "../messages/mention-draft";
import { sendWithOwnerMentions } from "../relay/owner-mentions";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { agentUnavailable, canMessageAgent } from "../agents/choices";
import { avatarMedia } from "../../shared/avatar-source";
import type { ChannelSummary } from "../relay/contracts";
import { sameDirectMessage } from "../relay/direct-message-policy";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import { composerMarkdown } from "../messages/composer-markdown";
import { restoreChatLinks } from "../messages/composer-chat-cards";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { attachmentMessage } from "../relay/attachments";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import { DraftMentionRoster } from "../messages/draft-mention-roster";
import {
  clearAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import { MessageComposer } from "../messages/MessageComposer";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { clearView, readView, writeView } from "../../shared/view-state";
import type { MessageIntent } from "../channel-navigation/routes";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { startingChatTitle } from "../solo/chat-title";
import {
  effectiveLifetime,
  effectiveVisibility,
} from "../solo/default-lifetime";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type { Profile } from "../relay/contracts";
import {
  useVerifiedNames,
  withVerifiedNames,
} from "../profiles/useVerifiedNames";
import { abbreviatedPublicKey } from "../../shared/identity/public-key";
import { RecipientPicker } from "./RecipientPicker";
import { recipientView, type Recipient } from "./usePeople";
import { usePassThroughUntilDrafted } from "../messages/draft-visit";
import type { PageNavigation } from "../navigation/service";
import styles from "./NewMessage.module.css";

const draftKey = "direct-message:new-draft";
const titleKey = "direct-message:title";
const recoveryKey = "direct-message:new";

type Pending = {
  id: string;
  channelId: string;
  workspace?: string;
  starred?: true;
  recipients: string;
  draft: MentionDraft;
  attachments: readonly (readonly string[])[];
};
const keyFor = (people: readonly Recipient[]) =>
  people
    .map((person) => person.pubkey)
    .sort()
    .join(":");
function savedRecipients(scope: string, viewer?: string) {
  return validRecipients(
    readView<unknown>(scope, "direct-message:recipients", []),
    viewer,
  );
}
/** Whether `intent` is a choice newer than the last one this draft took. */
function untaken(scope: string, intent: MessageIntent | undefined) {
  const taken = readView<unknown>(scope, "direct-message:addressed-at", 0);
  return !!intent && !(typeof taken === "number" && intent.at <= taken);
}
function validRecipients(saved: unknown, viewer?: string) {
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
            typeof person.name === "string",
        )
        .map((person) => [person.pubkey, recipientView(person)]),
    ).values(),
  ].slice(0, 8);
}
// Earlier development builds wrote a separate pointer. Keep it confirmation-only;
// its absence from the journal must never authorize a replacement message.
function savedLegacy(scope: string, viewer?: string) {
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
      attachments: [],
      people: savedRecipients(scope, viewer),
    };
}

function recovered(operations: readonly OutgoingEvent[], viewer?: string) {
  const item = operations.find((item) => item.recovery?.key === recoveryKey);
  if (!item?.recovery) return undefined;
  const value = JSON.parse(item.recovery.value);
  const people = validRecipients(value.people, viewer);
  const channelId = item.event.tags.find(([name]) => name === "h")?.[1];
  if (item.event.kind !== 9 || !channelId || !people.length)
    throw new Error("The saved new message could not be restored.");
  return {
    id: item.event.id,
    channelId,
    ...(typeof value.workspace === "string" &&
    value.workspace.trim() &&
    value.workspace.length <= 256
      ? { workspace: value.workspace }
      : value.starred === true
        ? { starred: true as const }
        : {}),
    recipients: keyFor(people),
    draft: mentionDraft(value.draft),
    attachments: item.event.tags.filter(([name]) => name === "imeta"),
    people,
  };
}

/** Recipient-first conversation that can open directly or send through the durable outbox. */
export function NewMessage({
  session,
  scope,
  extensions,
  channels,
  onPreparing,
  onStarted,
  onOpenChat,
  visit,
  intent,
  workspace,
  starred,
  solo,
  dmIdentity,
}: {
  /** The picked people's identity as their DM shows in the sidebar. */
  dmIdentity?:
    | ((identity: {
        members: readonly string[];
        profiles: ReadonlyMap<string, Profile>;
        fallback: string;
      }) => ReactNode)
    | undefined;
  /** A new Solo chat, shown while no person is picked: with the agent picked
   * in To, or the default one, and the page's title as its name. */
  solo?:
    | ((start: {
        agent?: string;
        name: string;
        focusRequest: number;
      }) => ReactNode)
    | undefined;
  /** Open one of the picked group's named conversations instead. */
  onOpenChat?: ((channelId: string) => void) | undefined;
  session: RelaySession;
  scope: string;
  /** The person this visit was opened from, such as by their profile's Message. */
  intent?: MessageIntent | undefined;
  workspace?: string | undefined;
  /** File the conversation in Favorites once it is delivered. */
  starred?: boolean | undefined;
  /** The visit presenting this composer, a Back stop only once drafted. */
  visit?: PageNavigation | undefined;
  extensions?: ConversationExtensions | undefined;
  channels: readonly ChannelSummary[];
  host: ConversationHostServices;
  onPreparing?(pubkeys: readonly string[]): void;
  onOpenThread(
    channelId: string,
    messageId: string,
    threadRootId: string,
    intent?: "reply",
  ): void;
  onStarted(channelId: string, messageId: string): void;
}) {
  // A message held for delivery or retry stays a Back stop even when its
  // draft view is gone or it carries only attachments.
  const held = useRef(false);
  const holds = useCallback(() => held.current, []);
  const draftEdited = usePassThroughUntilDrafted(
    visit,
    session,
    scope,
    draftKey,
    { held: holds },
  );
  const [recipients, setRecipients] = useState(() =>
    savedRecipients(scope, session.viewer),
  );
  // Recipients keep the facts they were chosen with; their labels follow the
  // current verification and otherwise the current profile name, falling back
  // to those facts.
  const verified = useVerifiedNames(session, recipients);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const named = useMemo(
    () =>
      withVerifiedNames(
        recipients.map((person) => {
          const current = profiles.get(person.pubkey);
          return current && !current.verified
            ? { ...person, name: current.name }
            : person;
        }),
        verified,
        profiles,
      ),
    [recipients, verified, profiles],
  );
  const recipientNames = named.map((person) => person.name).join(", ");
  const roster = useMemo(() => ({ recipients }), [recipients]);
  // An optional name. Without one, the first message names the conversation.
  const [title, setTitle] = useState(() => {
    const saved = readView<unknown>(scope, titleKey, "");
    return typeof saved === "string" ? saved : "";
  });
  const changeTitle = (next: string) => {
    setTitle(next);
    writeView(scope, titleKey, next || null);
  };
  // "Direct message" chosen for people without a DM yet: the message starts
  // their DM rather than a new conversation.
  const [direct, setDirect] = useState(false);
  const startable = direct
    ? session.directMessages.available
    : session.channelWrites.available;
  // Agents never change whose conversation it is, as in a DM.
  const isAgent = (person: Recipient) =>
    !!person.isAgent || !!profiles.get(person.pubkey)?.isAgent;
  const people = named.filter((person) => !isAgent(person));
  const peopleNames = new Intl.ListFormat(undefined, {
    type: "conjunction",
  }).format(people.map((person) => person.name));
  // Text still in the To field may be a recipient not chosen yet, so Send
  // waits for it to become one or be cleared.
  const [typed, setTyped] = useState(false);
  const [legacy, setLegacy] = useState(() =>
    savedLegacy(scope, session.viewer),
  );
  const initialLegacy = useRef(legacy);
  const [ready, setReady] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<MentionDraft>();
  const [draftRevision, setDraftRevision] = useState(0);
  const [composerFocus, setComposerFocus] = useState(0);
  const focusComposer = useCallback(() => {
    setComposerFocus((request) => request + 1);
  }, []);
  // New message starts in the message, so clicking + and typing reaches an
  // agent. To stays closed until it's clicked or typed in.
  useEffect(() => {
    if (ready && !document.activeElement?.closest("input")) focusComposer();
  }, [ready, focusComposer]);
  const retiring = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState<"uploading" | "sending" | undefined>();
  const [error, setError] = useState("");
  const [uploadFailed, setUploadFailed] = useState(false);
  const [draftChannel] = useState(() => crypto.randomUUID());
  const attempt = useRef<AbortController | null>(null);
  const outbox = session.outbox;
  const operations = useSyncExternalStore(
    outbox?.subscribe ?? noSubscribe,
    outbox?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  let pending: (Pending & { people: Recipient[] }) | undefined;
  try {
    pending = recovered(operations, session.viewer) ?? legacy;
  } catch {
    /* Readiness presents invalid recovery. */
  }
  held.current = !!pending;
  const failed =
    pending && session.directMessages.delivery(pending.id) === "failed";
  const locked = !ready || !!busy || (!!pending && !failed);
  const retire = useCallback(() => {
    clearAttachmentDraft(session, `${scope}:${draftKey}`);
    retiring.current = undefined;
    draftEdited(undefined);
    setRecipients([]);
    setTitle("");
    setDirect(false);
    setRestoredDraft(mentionDraft(""));
    setDraftRevision((revision) => revision + 1);
  }, [session, scope, draftEdited]);
  useLayoutEffect(() => {
    const confirmed = pending && session.directMessages.delivery(pending.id);
    if (pending) {
      retiring.current =
        confirmed === "accepted" || confirmed === "seen"
          ? pending.id
          : undefined;
    } else if (retiring.current) {
      // A different mount may have completed acknowledgement while this page
      // restored its recovery payload. Never leave that payload as a fresh draft.
      retire();
    }
  }, [pending, session.directMessages, retire]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await outbox?.ready();
        if (!active) return;
        const saved =
          recovered(outbox?.snapshot() ?? [], session.viewer) ??
          initialLegacy.current;
        if (saved) {
          const editable =
            session.directMessages.delivery(saved.id) === "failed";
          setRecipients(
            editable
              ? validRecipients(
                  readView(scope, "direct-message:recipients", saved.people),
                  session.viewer,
                )
              : saved.people,
          );
          setRestoredDraft(
            editable
              ? mentionDraft(readView(scope, draftKey, saved.draft))
              : saved.draft,
          );
        }
        setReady(true);
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not restore the message.",
          );
      }
    })();
    return () => {
      active = false;
      attempt.current?.abort();
    };
  }, [outbox, session.viewer, session.directMessages, scope]);
  function validateAgents() {
    const controlled = new Set(
      session.agentChoices
        .snapshot()
        // Forward-looking: neither archived nor being deleted.
        .selectable.filter(canMessageAgent)
        .map((agent) => agent.pubkey),
    );
    if (
      recipients.some(
        (person) =>
          // By key, whatever its profile says.
          agentUnavailable(session, person.pubkey) ||
          ((person.isAgent ||
            session.profiles.snapshot().get(person.pubkey)?.isAgent) &&
            !controlled.has(person.pubkey)),
      )
    )
      throw new Error(
        "A selected agent is no longer available. Remove it or refresh its details and try again.",
      );
  }
  function change(people: Recipient[]) {
    if (locked || attempt.current) return;
    setRecipients(people);
    setDirect(false);
    writeView(scope, "direct-message:recipients", people.map(recipientView));
    setError("");
    setUploadFailed(false);
  }
  // Opened from a person, the restored draft is addressed to them as if they
  // were chosen in To. Only a choice newer than the last one taken addresses
  // it, so returning to a visit (Back, reload, closing Settings) keeps the
  // recipients chosen since, and choosing someone again addresses it anew. A
  // message held for delivery, even a failed one, keeps its recipients, so a
  // retry never reaches someone new. A choice made while a send is under way
  // waits for it, so the send keeps its recipients and the choice is not lost.
  // With To already filled, the caret starts in the message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each choice addresses the draft once, after its restore and any send under way.
  useEffect(() => {
    if (!ready || !intent || busy || !untaken(scope, intent)) return;
    writeView(scope, "direct-message:addressed-at", intent.at);
    const { to } = intent;
    if (pending || to === session.viewer) return;
    const profile = session.profiles.snapshot().get(to);
    void session.profiles.ensure([to]).catch(() => {});
    change([
      {
        pubkey: to,
        name: profile?.name ?? abbreviatedPublicKey(to) ?? "",
        ...(profile?.isAgent ? { isAgent: true } : {}),
      },
    ]);
    focusComposer();
  }, [ready, busy, intent?.to, intent?.at]);
  async function send(
    draft: MentionDraft,
    files?: AttachmentDraft,
    explicitRecipientIds?: readonly string[],
  ) {
    const content = composerMarkdown(draft);
    if (
      attempt.current ||
      !ready ||
      !recipients.length ||
      (!content.trim() && !files?.snapshot().length && !pending) ||
      !startable
    )
      return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(
      files?.snapshot().some((file) => !file.uploaded)
        ? "uploading"
        : "sending",
    );
    setError("");
    setUploadFailed(false);
    const key = keyFor(recipients);
    let current: Pending | undefined = pending;
    let preparingFiles = !!files;
    try {
      // Confirmation-only retries must retain the exact durable event.
      const uploaded = files
        ? await files.prepareForSend(controller.signal)
        : [];
      controller.signal.throwIfAborted();
      preparingFiles = false;
      setBusy("sending");
      // Compare the complete published metadata; messages.send still validates
      // every upload against the actual community origin.
      const attachments = attachmentMessage(
        "",
        uploaded,
        uploaded[0]?.url,
      ).tags;
      if (current && session.directMessages.delivery(current.id) === "failed")
        validateAgents();
      if (
        current &&
        (current.recipients !== key ||
          JSON.stringify(mentionDraft(restoreChatLinks(current.draft))) !==
            JSON.stringify(mentionDraft(restoreChatLinks(draft))) ||
          (files &&
            JSON.stringify(current.attachments) !==
              JSON.stringify(attachments)))
      ) {
        if (session.directMessages.delivery(current.id) !== "failed")
          throw new Error(
            "Retry the earlier message to confirm its delivery before editing.",
          );
        validateAgents();
        await outbox?.dismiss(current.id);
        controller.signal.throwIfAborted();
        current = undefined;
        setLegacy(undefined);
        writeView(scope, "direct-message:pending", null);
      }
      if (!current) {
        validateAgents();
        const members = recipients.map((person) => person.pubkey);
        let id: string;
        if (direct) {
          onPreparing?.(members);
          // The relay picks the DM of these people, and named agents join it
          // with its history. Every new message asks again: someone may have
          // joined the DM it gave an earlier attempt.
          id = await session.directMessages.open(
            members,
            controller.signal,
            true,
          );
        } else {
          // Anything else starts a new conversation with these people, named
          // by the title or else the first message. It lists at once, and the
          // message goes out once the relay has made it.
          id = crypto.randomUUID();
          session.channelWrites.start(
            id,
            canonicalDetailsName(title) || startingChatTitle(draft),
            members,
            effectiveLifetime(scope, workspace),
            false,
            undefined,
            { solo: false, visibility: effectiveVisibility(scope, workspace) },
          );
        }
        controller.signal.throwIfAborted();
        validateAgents();
        const messageId = sendWithOwnerMentions(
          session,
          explicitRecipientIds,
          () =>
            session.messages.send(
              id,
              content,
              draft.recipients.map((person) => person.pubkey),
              uploaded,
              {
                key: recoveryKey,
                value: JSON.stringify({
                  people: recipients.map(recipientView),
                  draft,
                  ...(workspace ? { workspace } : {}),
                  ...(starred ? { starred } : {}),
                }),
              },
            ),
        );
        current = {
          id: messageId,
          channelId: id,
          ...(workspace ? { workspace } : {}),
          ...(starred ? { starred: true as const } : {}),
          recipients: key,
          draft,
          attachments,
        };
      }
      await session.directMessages.delivered(
        current.id,
        current.channelId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (current.workspace) {
        // Placement can recover through the sidebar without repeating delivery.
        void session.sidebarPreferences
          .assign(current.channelId, current.workspace)
          .catch(() => {});
      } else if (current.starred) {
        void session.sidebarPreferences
          .setStar(current.channelId, true)
          .catch(() => {});
      }
      // Clear disposable views before releasing durable recovery. A failed clear
      // retains the operation for confirmation-only retry, even across unmount.
      clearView(
        scope,
        draftKey,
        `${draftKey}:files`,
        "direct-message:pending",
        "direct-message:recipients",
        titleKey,
      );
      await outbox?.acknowledge(current.id);
      if (controller.signal.aborted) return;
      setLegacy(undefined);
      // The page can stay mounted (Settings open), so never leave the sent
      // message as an editable draft that could be published again.
      retire();
      onStarted(current.channelId, current.id);
    } catch (reason) {
      if (!controller.signal.aborted && preparingFiles) setUploadFailed(true);
      else if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not send your message. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
      if (attempt.current === controller) attempt.current = null;
    }
  }
  const existing = useMemo(() => {
    if (!recipients.length || !session.viewer) return undefined;
    const agents = new Set(
      recipients
        .filter((person) => person.isAgent)
        .map((person) => person.pubkey),
    );
    const members = new Set([
      session.viewer,
      ...recipients.map((person) => person.pubkey),
    ]);
    let match: ChannelSummary | undefined;
    for (const channel of channels) {
      if (
        channel.channelType !== "dm" ||
        channel.archived ||
        channel.cached ||
        channel.readOnly ||
        channel.pending ||
        channel.huddle ||
        !channel.members ||
        !sameDirectMessage(
          channel.members,
          members,
          (key) => agents.has(key) || !!profiles.get(key)?.isAgent,
        )
      )
        continue;
      const activity = channel.lastActivityAt ?? 0;
      const latest = match?.lastActivityAt ?? 0;
      if (
        !match ||
        activity > latest ||
        (activity === latest && channel.id.localeCompare(match.id) < 0)
      )
        match = channel;
    }
    return match;
  }, [channels, recipients, session.viewer, profiles]);
  // Named conversations with exactly these people, newest first. Like a DM,
  // a conversation is known by its people: agents in it never change whose
  // it is.
  const namedConversations = useMemo(() => {
    const viewer = session.viewer;
    if (!viewer || !onOpenChat) return [];
    const agentKey = (key: string) =>
      recipients.some((person) => person.pubkey === key && person.isAgent) ||
      !!profiles.get(key)?.isAgent;
    const group = new Set(
      recipients.map((person) => person.pubkey).filter((key) => !agentKey(key)),
    );
    if (!group.size) return [];
    return channels
      .filter((channel) => {
        if (
          (channel.channelType !== "solo" &&
            channel.channelType !== "stream") ||
          !channel.name ||
          channel.archived ||
          channel.cached ||
          channel.pending ||
          channel.huddle ||
          !channel.members?.includes(viewer)
        )
          return false;
        const people = new Set(
          channel.members.filter((key) => key !== viewer && !agentKey(key)),
        );
        return (
          people.size === group.size &&
          [...people].every((key) => group.has(key))
        );
      })
      .sort(
        (left, right) =>
          (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0),
      );
  }, [channels, recipients, session.viewer, profiles, onOpenChat]);
  // Who is an agent comes from profiles, so load the unknown members of rooms
  // that could be this group's before matching them.
  useEffect(() => {
    const viewer = session.viewer;
    if (!viewer || !onOpenChat || !recipients.length) return;
    const picked = recipients.map((person) => person.pubkey);
    const unknown = new Set<string>();
    for (const channel of channels) {
      if (
        (channel.channelType !== "solo" && channel.channelType !== "stream") ||
        !channel.members?.includes(viewer) ||
        !picked.every((key) => channel.members?.includes(key))
      )
        continue;
      for (const key of channel.members)
        if (key !== viewer && !profiles.has(key)) unknown.add(key);
    }
    if (unknown.size)
      void session.profiles.ensure([...unknown]).catch(() => {});
  }, [channels, recipients, session, profiles, onOpenChat]);
  const openNamed = (channelId: string) => {
    if (!locked) onOpenChat?.(channelId);
  };
  // Two fields: an optional name, then To.
  const header = (
    <div className={styles.header}>
      <Field label="Name" labelVisibility="hidden">
        <Input
          value={direct ? "" : title}
          maxLength={120}
          autoComplete="off"
          placeholder={direct ? peopleNames : "New message"}
          disabled={locked || direct}
          onChange={(event) => changeTitle(event.target.value)}
        />
      </Field>
      <RecipientPicker
        session={session}
        scope={scope}
        selected={recipients}
        labels={named}
        disabled={locked}
        onChange={change}
        initiallyOpen={false}
        // After a pick, the group's conversations show; typing brings the
        // people list back for the next name.
        searchOnly={recipients.length > 0}
        onComplete={focusComposer}
        onTyped={setTyped}
      />
    </div>
  );
  // With no person picked, this is a new Solo chat with its agent.
  if (solo && !people.length && !pending)
    return (
      <section
        className={styles.page}
        aria-label="New message"
        data-attachment-drop-zone
      >
        {header}
        {solo({
          ...(recipients[0] ? { agent: recipients[0].pubkey } : {}),
          name: title,
          focusRequest: composerFocus,
        })}
      </section>
    );
  const composerName = direct
    ? peopleNames
    : canonicalDetailsName(title) || undefined;
  return (
    <section
      className={styles.page}
      aria-label="New message"
      data-attachment-drop-zone
    >
      {header}
      <div className={styles.blank} data-new-message-body="">
        {people.length > 0 && (
          <div className={styles.introduction}>
            <div className={styles.group}>
              <AvatarStack
                animateEntrance
                size="hero-large"
                max={5}
                items={people.map((person) => ({
                  id: person.pubkey,
                  name: person.name,
                  src: avatarMedia(person.picture, session.media),
                  shape: "circle",
                }))}
              />
              <NavigationSection>
                {/* Their DM as the sidebar shows it, new or with history. */}
                <NavigationItem
                  label={existing?.name || people.map((p) => p.name).join(", ")}
                  icon={dmIdentity?.({
                    members: people.map((person) => person.pubkey),
                    profiles,
                    fallback: peopleNames,
                  })}
                  selected={direct}
                  aria-current={false}
                  aria-pressed={existing ? undefined : direct}
                  disabled={locked}
                  trailing="Direct message"
                  aria-label={`Direct message with ${peopleNames}`}
                  onClick={() => {
                    if (existing) openNamed(existing.id);
                    else {
                      setDirect((chosen) => !chosen);
                      focusComposer();
                    }
                  }}
                />
                {namedConversations.map((channel) => (
                  <NavigationItem
                    key={channel.id}
                    label={channel.name}
                    disabled={locked}
                    trailing={
                      channel.lastActivityAt
                        ? relativeTimestamp(channel.lastActivityAt)
                        : undefined
                    }
                    onClick={() => openNamed(channel.id)}
                  />
                ))}
              </NavigationSection>
            </div>
          </div>
        )}
      </div>
      <div className={styles.feedback}>
        {busy && (
          <p role="status">
            {busy === "uploading" ? "Uploading files…" : "Sending message…"}
          </p>
        )}
        {uploadFailed && (
          // A failed send also pauses the files queued behind the one that
          // failed, and each chip names its own way out.
          <p role="status">
            A file couldn’t upload. Follow the guidance on each file that shows
            an error, then send again.
          </p>
        )}
        {people.length > 0 && !startable && (
          <p role="status">
            {direct
              ? "Starting direct messages is unavailable on this connection."
              : "Starting conversations is unavailable on this connection."}
          </p>
        )}
        {pending && !failed && !busy && !error && (
          <Button
            type="button"
            onClick={() => pending && void send(pending.draft)}
          >
            Retry send
          </Button>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {pending && !failed && (
              <Button
                type="button"
                disabled={!!busy}
                onClick={() => pending && void send(pending.draft)}
              >
                Retry send
              </Button>
            )}
          </div>
        )}
      </div>
      <DraftMentionRoster.Provider value={roster}>
        <MessageComposer
          evidenceOwner={hostComposerProvenance}
          key={`${ready ? "ready" : "hydrating"}:${draftRevision}`}
          session={session}
          scope={scope}
          extensions={extensions}
          channelId={draftChannel}
          focusRequest={composerFocus}
          channelName={composerName ?? (recipientNames || "new message")}
          label={
            composerName
              ? `Message ${composerName}`
              : recipientNames
                ? "Start a new conversation"
                : "New message"
          }
          placeholder={
            composerName
              ? `Message ${composerName}`
              : recipientNames
                ? "Start a new conversation"
                : ""
          }
          disabled={!recipients.length}
          submission={{
            draftKey,
            attachments: true,
            allowAttachmentOnly: true,
            recoveredDraft: restoredDraft,
            onDraftChange: draftEdited,
            locked,
            disabled:
              !ready || !!busy || !recipients.length || typed || !startable,
            submit: (
              draft,
              files,
              _addressed,
              _picks,
              _draftPicks,
              _revision,
              explicitRecipientIds,
            ) => void send(draft, files, explicitRecipientIds),
          }}
        />
      </DraftMentionRoster.Provider>
    </section>
  );
}
const empty: readonly never[] = [];
const emptySnapshot = () => empty;
const noSubscribe = () => () => {};
