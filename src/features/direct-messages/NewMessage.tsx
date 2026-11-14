import { agentUnavailable } from "../agents/choices";
import {
  creationDestinationKey,
  readCreationDestination,
  saveCreationDestination,
  type CreationDestination,
} from "./creation-destination";
import { SoloDraft } from "../solo/SoloDraft";
import type { ComponentProps } from "react";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { createPortal } from "react-dom";
import { canMessageAgent } from "../agents/choices";
import { useAgentChoices } from "../agents/use-choices";
import { avatarMedia } from "../../shared/avatar-source";
import type { ChannelSummary } from "../relay/contracts";
import type { ConversationHostServices } from "../conversation/ConversationHost";
import { composerMarkdown } from "../messages/composer-markdown";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import { DraftMentionRoster } from "../messages/draft-mention-roster";
import {
  clearAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import { MessageComposer } from "../messages/MessageComposer";
import type { MentionDraft, MentionRecipient } from "../messages/mention-draft";
import { directMessageWith } from "../relay/direct-message-policy";
import { clearView, readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import {
  useVerifiedNames,
  withVerifiedNames,
} from "../profiles/useVerifiedNames";
import { addressableChannels, RecipientPicker } from "./RecipientPicker";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { PlusIcon } from "../../shared/design-system/icons";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { usePeople, type Recipient } from "./usePeople";
import { usePassThroughUntilDrafted } from "../messages/draft-visit";
import type { PageNavigation } from "../navigation/service";
import styles from "./NewMessage.module.css";
import { ExistingDiscussion } from "./ExistingDiscussion";

const draftKey = "direct-message:new-draft";
const channelViewKey = "direct-message:channel";
const teamViewKey = "direct-message:team-for";
type Kind = "solo" | "team";
const keyFor = (people: readonly Recipient[]) =>
  people
    .map((person) => person.pubkey)
    .sort()
    .join(":");
// Earlier versions held a first message here until the relay confirmed it.
const heldMessageKey = "direct-message:new";

/** Recipient-first start of a conversation: it chooses where the first message
 * goes and queues it there. Delivery and Retry belong to that conversation. */
export function NewMessage({
  session,
  scope,
  extensions,
  channels,
  onPreparing,
  host,
  onOpenThread,
  onStarted,
  visit,
  allowChannels = false,
  layout = "page",
  expanded = false,
  onAddressed,
  contentContainer,
  solo,
  onOpenChat,
}: {
  /** Activity embeds the same draft and delivery owner without a second history. */
  layout?: "page" | "composer";
  expanded?: boolean;
  onAddressed?: (() => void) | undefined;
  /** Move the presentation into the host's expanded surface; this owner stays mounted. */
  contentContainer?: HTMLElement | null;
  /** To may also name a channel: Send posts a new message there. */
  allowChannels?: boolean;
  /** Solo uses the same creation draft and parent lock as Team. */
  solo?:
    | Pick<ComponentProps<typeof SoloDraft>, "onStarted" | "onFailed">
    | undefined;
  /** Continue an earlier Solo chat listed beside a chosen agent. */
  onOpenChat?: ((channelId: string) => void) | undefined;
  session: RelaySession;
  scope: string;
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
  const draftEdited = usePassThroughUntilDrafted(
    visit,
    session,
    scope,
    draftKey,
  );
  const [destination, setDestination] = useState(() =>
    readCreationDestination(scope, session.viewer, allowChannels),
  );
  const recipients =
    destination.kind === "people" ? destination.people : emptyRecipients;
  const channelId =
    destination.kind === "channel" ? destination.channelId : undefined;
  // A lone agent starts a Solo chat unless Team was picked for it.
  const [teamFor, setTeamFor] = useState(() => {
    const saved = readView<unknown>(scope, teamViewKey, null);
    return typeof saved === "string" ? saved : undefined;
  });
  // Recipients keep the facts they were chosen with; their labels follow the
  // current verification and otherwise the current profile name, falling back
  // to those facts.
  const verified = useVerifiedNames(session, recipients);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const agents = useAgentChoices(
    session,
    layout === "composer",
    layout === "composer",
  );
  const named = useMemo(
    () =>
      withVerifiedNames(
        recipients.map((person) => {
          const current = profiles.get(person.pubkey);
          const picture =
            current?.picture ??
            person.picture ??
            agents.identities.find((agent) => agent.pubkey === person.pubkey)
              ?.avatar;
          return {
            ...person,
            ...(current && !current.verified ? { name: current.name } : {}),
            ...(picture ? { picture } : {}),
          };
        }),
        verified,
        profiles,
      ),
    [recipients, verified, profiles, agents.identities],
  );
  const recipientNames = named.map((person) => person.name).join(", ");
  const [inlineQuery, setInlineQuery] = useState<string>();
  const directory = usePeople(
    session,
    inlineQuery ?? "",
    layout === "composer" && inlineQuery !== undefined,
  );
  const inlinePeople = useMemo(() => {
    const eligible = new Set(
      agents.identities.filter(canMessageAgent).map((agent) => agent.pubkey),
    );
    return [
      ...new Map(
        [
          ...[...profiles].map(([pubkey, profile]) => ({ ...profile, pubkey })),
          ...directory.people,
          ...agents.selectable.map((agent) => ({
            ...agent,
            isAgent: true as const,
          })),
          ...named,
        ]
          .filter(
            (person) =>
              person.pubkey !== session.viewer &&
              (!person.isAgent || eligible.has(person.pubkey)),
          )
          .map((person) => [person.pubkey, person]),
      ).values(),
    ];
  }, [
    agents.identities,
    agents.selectable,
    profiles,
    directory.people,
    named,
    session.viewer,
  ]);
  const roster = useMemo(
    () =>
      layout === "composer"
        ? { recipients: inlinePeople, onQuery: setInlineQuery }
        : { recipients },
    [layout, inlinePeople, recipients],
  );
  // Text still in the To field may be a recipient not chosen yet, so Send
  // waits for it to become one or be cleared.
  const [typed, setTyped] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);
  const [composerFocus, setComposerFocus] = useState(0);
  const focusComposer = useCallback(() => {
    setComposerFocus((request) => request + 1);
  }, []);
  const previousContainer = useRef(contentContainer);
  useLayoutEffect(() => {
    if (previousContainer.current === contentContainer) return;
    previousContainer.current = contentContainer;
    focusComposer();
  }, [contentContainer, focusComposer]);
  const [busy, setBusy] = useState<"uploading" | "opening" | undefined>();
  const [error, setError] = useState("");
  const [uploadFailed, setUploadFailed] = useState(false);
  const [draftChannel] = useState(() => crypto.randomUUID());
  const attempt = useRef<AbortController | null>(null);
  const [soloBusy, setSoloBusy] = useState(false);
  const locked = soloBusy || !!busy;
  useEffect(() => () => attempt.current?.abort(), []);
  useEffect(() => {
    // Release a message an earlier version still holds to its conversation.
    const outbox = session.outbox;
    void outbox?.ready().then(() => {
      for (const item of outbox.snapshot())
        if (item.recovery?.key === heldMessageKey)
          void outbox.acknowledge(item.event.id).catch(() => {});
    });
  }, [session.outbox]);
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
    const next: CreationDestination = { kind: "people", people };
    setDestination(next);
    saveCreationDestination(scope, next);
    setError("");
    setUploadFailed(false);
  }
  function syncInlineRecipients(draft: MentionDraft) {
    if (layout !== "composer") return;
    const people = draft.recipients.map(
      (person) =>
        inlinePeople.find((candidate) => candidate.pubkey === person.pubkey) ??
        person,
    );
    if (keyFor(people) === keyFor(recipients)) return;
    change(people);
    if (people.length) onAddressed?.();
  }
  function chooseChannel(channel: ChannelSummary | undefined) {
    if (locked || attempt.current) return;
    const next: CreationDestination = channel
      ? { kind: "channel", channelId: channel.id }
      : { kind: "people", people: [] };
    setDestination(next);
    saveCreationDestination(scope, next);
    setError("");
    setUploadFailed(false);
  }
  async function send(
    draft: MentionDraft,
    files?: AttachmentDraft,
    addressed?: readonly MentionRecipient[],
    references: readonly string[] = [],
  ) {
    const content = composerMarkdown(draft);
    if (
      attempt.current ||
      (!target && !recipients.length) ||
      (!content.trim() && !files?.snapshot().length) ||
      (!target && !session.directMessages.available)
    )
      return;
    const controller = new AbortController();
    attempt.current = controller;
    setError("");
    setUploadFailed(false);
    let uploading = !!files?.snapshot().some((file) => !file.uploaded);
    if (uploading) setBusy("uploading");
    try {
      const uploaded = files
        ? await files.prepareForSend(controller.signal)
        : [];
      controller.signal.throwIfAborted();
      uploading = false;
      let channelId = target?.id;
      if (!channelId) {
        validateAgents();
        const pubkeys = recipients.map((person) => person.pubkey);
        // Only a DM that must be created waits on the relay.
        if (!existing) {
          onPreparing?.(pubkeys);
          setBusy("opening");
        }
        channelId = await session.directMessages.open(
          pubkeys,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        validateAgents();
      }
      const messageId = session.messages.send(
        channelId,
        content,
        (addressed ?? draft.recipients).map((person) => person.pubkey),
        uploaded,
        undefined,
        references,
      );
      // The message is its conversation's now. The page can stay mounted
      // (Settings open), so it must not remain a draft to send again.
      clearView(
        scope,
        draftKey,
        "direct-message:pending",
        "direct-message:recipients",
        channelViewKey,
        creationDestinationKey,
        teamViewKey,
      );
      clearAttachmentDraft(session, `${scope}:${draftKey}`);
      draftEdited(undefined);
      setDestination({ kind: "people", people: [] });
      setTeamFor(undefined);
      setDraftRevision((revision) => revision + 1);
      onStarted(channelId, messageId);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (uploading) setUploadFailed(true);
      else
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
  const existing = useMemo(
    () =>
      directMessageWith(
        channels,
        session.viewer,
        recipients.map((person) => person.pubkey),
      ),
    [channels, recipients, session.viewer],
  );
  const channelChoices = useMemo(
    () => (allowChannels ? addressableChannels(channels) : []),
    [allowChannels, channels],
  );
  const target = channelId
    ? channelChoices.find((channel) => channel.id === channelId)
    : undefined;
  const lone = recipients.length === 1 ? recipients[0] : undefined;
  const loneAgent =
    solo &&
    !target &&
    lone &&
    (lone.isAgent || profiles.get(lone.pubkey)?.isAgent)
      ? lone.pubkey
      : undefined;
  const kind: Kind | null =
    solo && loneAgent && teamFor !== loneAgent
      ? "solo"
      : target || recipients.length || !solo
        ? "team"
        : null;
  const soloAgent = kind === "solo" ? loneAgent : undefined;
  const agentLabel = soloAgent ? named[0]?.name : undefined;
  const recent = useMemo(
    () =>
      soloAgent
        ? channels
            .filter(
              (channel) =>
                channel.channelType === "solo" &&
                !channel.archived &&
                !channel.pending &&
                channel.members?.includes(soloAgent),
            )
            .sort(
              (left, right) =>
                (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0),
            )
            .slice(0, 3)
        : [],
    [channels, soloAgent],
  );
  const kindControl =
    solo || allowChannels ? (
      <div className={styles.kind}>
        <Tabs<Kind>
          variant="segmented"
          size="sm"
          label="Conversation"
          value={kind}
          showSelection={kind !== null}
          items={[
            {
              value: "solo",
              label: "Solo",
              disabled: locked || !solo || !loneAgent,
            },
            { value: "team", label: "Team", disabled: locked || kind === null },
          ]}
          onValueChange={(next) => {
            if (locked || !loneAgent) return;
            const choice = next === "team" ? loneAgent : undefined;
            setTeamFor(choice);
            writeView(scope, teamViewKey, choice ?? null);
          }}
        />
      </div>
    ) : undefined;
  const displayed = target ?? existing;
  const composerName = target ? `#${target.name}` : recipientNames;
  const recipientArtwork = (solo: boolean) => (
    <AvatarStack
      animateEntrance
      size="hero-large"
      max={solo ? 1 : 5}
      items={named.map((person) => ({
        id: person.pubkey,
        name: person.name,
        src: avatarMedia(person.picture, session.media),
        shape: solo || person.isAgent ? "squircle" : "circle",
      }))}
    />
  );
  const content = (
    <section
      className={styles.page}
      data-layout={layout}
      data-expanded={expanded || undefined}
      aria-label="New message"
      data-attachment-drop-zone
    >
      {layout === "page" && (
        <RecipientPicker
          session={session}
          scope={scope}
          initiallyOpen={layout === "page"}
          selected={recipients}
          labels={named}
          disabled={locked}
          onChange={change}
          onComplete={focusComposer}
          onTyped={setTyped}
          channelOptions={channelChoices}
          selectedChannel={target}
          onChooseChannel={allowChannels ? chooseChannel : undefined}
          trailing={kindControl}
        />
      )}
      {soloAgent && solo ? (
        <>
          {(layout === "page" || expanded) && (
            <div className={styles.solo} data-new-message-body="">
              {recipientArtwork(true)}
              {recent.length > 0 && (
                <nav
                  className={styles.recent}
                  aria-label={`Recent chats with ${agentLabel}`}
                >
                  <h3>Recent with {agentLabel}</h3>
                  <NavigationItem
                    selected
                    aria-current="true"
                    icon={<PlusIcon size={16} aria-hidden="true" />}
                    label="New chat"
                    onClick={focusComposer}
                  />
                  {recent.map((chat) => (
                    <NavigationItem
                      key={chat.id}
                      label={chat.name}
                      trailing={
                        chat.lastActivityAt ? (
                          <span className={styles.agent}>
                            {relativeTimestamp(chat.lastActivityAt)}
                          </span>
                        ) : undefined
                      }
                      onClick={() => onOpenChat?.(chat.id)}
                    />
                  ))}
                </nav>
              )}
            </div>
          )}
          <div className={styles.soloComposer}>
            <SoloDraft
              key={soloAgent}
              embedded
              draftPrefix="direct-message"
              session={session}
              scope={scope}
              extensions={extensions}
              agent={soloAgent}
              focusRequest={composerFocus}
              onDraftChange={
                layout === "composer" ? syncInlineRecipients : undefined
              }
              onBusyChange={setSoloBusy}
              {...solo}
            />
          </div>
        </>
      ) : (
        <>
          {(layout === "page" || expanded) && (
            <div className={styles.blank} data-new-message-body="">
              {displayed ? (
                <ExistingDiscussion
                  key={displayed.id}
                  session={session}
                  scope={scope}
                  channel={displayed}
                  extensions={extensions}
                  host={host}
                  onRecovered={focusComposer}
                  onOpen={(messageId, threadRootId, intent) =>
                    onOpenThread(displayed.id, messageId, threadRootId, intent)
                  }
                />
              ) : recipients.length > 0 ? (
                <div className={styles.introduction}>
                  {recipientArtwork(false)}
                </div>
              ) : null}
            </div>
          )}
          <div className={styles.feedback}>
            {layout === "composer" &&
              inlineQuery !== undefined &&
              directory.error && (
                <div role="alert">
                  <p>Could not search people. Your draft is kept.</p>
                  <Button type="button" onClick={directory.loadMore}>
                    Retry loading people
                  </Button>
                </div>
              )}
            {busy && (
              <p role="status">
                {busy === "uploading" ? "Uploading files…" : "Sending message…"}
              </p>
            )}
            {uploadFailed && (
              <p role="status">
                A file couldn’t upload. Retry or remove it, then send again.
              </p>
            )}
            {!target && !session.directMessages.available && (
              <p role="status">
                Starting direct messages is unavailable on this connection.
              </p>
            )}
            {error && (
              <div role="alert">
                <p>{error}</p>
              </div>
            )}
          </div>
          <DraftMentionRoster.Provider value={target ? undefined : roster}>
            <MessageComposer
              key={draftRevision}
              session={session}
              scope={scope}
              extensions={extensions}
              channelId={target?.id ?? draftChannel}
              focusRequest={composerFocus}
              channelName={composerName || "new message"}
              label={composerName ? `Message ${composerName}` : "New message"}
              placeholder={
                composerName
                  ? undefined
                  : layout === "composer"
                    ? "@mention someone to start a message…"
                    : ""
              }
              disabled={layout === "page" && !recipients.length && !target}
              submission={{
                channel: target ? true : undefined,
                draftKey,
                attachments: true,
                allowAttachmentOnly: true,
                onDraftChange: (draft) => {
                  draftEdited(draft);
                  syncInlineRecipients(draft);
                },
                locked,
                disabled:
                  !!busy ||
                  (target
                    ? false
                    : !recipients.length ||
                      !session.directMessages.available) ||
                  typed,
                submit: (
                  draft,
                  files,
                  addressed,
                  _picks,
                  _draftPicks,
                  _revision,
                  references,
                ) => void send(draft, files, addressed, references),
              }}
            />
          </DraftMentionRoster.Provider>
        </>
      )}
    </section>
  );
  return contentContainer ? createPortal(content, contentContainer) : content;
}

const emptyRecipients: Recipient[] = [];
