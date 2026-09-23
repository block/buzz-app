import { availableMentionAgents } from "../agents/mention-choices";
import { useAgentChoices } from "../agents/use-choices";
import { useLayoutEffect, useRef } from "react";
import { useIdentityNames } from "../identity-names/react";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";
import type { ConversationExtensions } from "../conversation/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import { scanMarkdown } from "../relay/message-content";
import { MessageMarkdown } from "./MessageMarkdown";
import type { MentionDraft } from "./mention-draft";
import { useReferenceDirectory } from "./ReferenceText";
import {
  readComposerSnapshot,
  composerMarkdownContext,
} from "./composer-document";
import { messageLinkParts } from "./message-link-parts";
import { messageReferences } from "./message-references";
import { EditableInput, type EditableInputProps } from "./EditableInput";

/** Decorations never change source text or infer notification recipients from names. */
export function RichComposerInput({
  draft,
  session,
  scope,
  channelId,
  extensions,
  emoji,
  inviteAgents = false,
  ...input
}: EditableInputProps & {
  draft: MentionDraft;
  session: RelaySession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  emoji: readonly CustomEmoji[];
  inviteAgents?: boolean;
}) {
  const directory = useReferenceDirectory(session);
  const profiles = new Map(directory.profiles);
  for (const recipient of draft.recipients)
    profiles.set(recipient.pubkey, {
      ...profiles.get(recipient.pubkey),
      name: recipient.name,
    });
  const resolveName = useIdentityNames(session.names);
  const agents = useAgentChoices(session, inviteAgents);
  const channel = directory.channels.find(
    (channel) => channel.id === channelId,
  );
  const available = availableMentionAgents(
    channel,
    agents.identities,
    inviteAgents,
    session.outbox?.supports(9000),
  );
  const candidates = [
    ...new Set([
      ...(channel?.members ?? []),
      ...available.map((agent) => agent.pubkey),
      ...(inviteAgents ? agents.identities.map((agent) => agent.pubkey) : []),
      ...draft.recipients.map((recipient) => recipient.pubkey),
    ]),
  ];
  const displayFacts = draft.recipients
    .filter((recipient) => !session.names?.lookup(recipient.pubkey, candidates))
    .map((recipient) => ({
      pubkey: recipient.pubkey,
      name: recipient.name,
    }));
  const qualifiers = new Map(
    draft.recipients.map((recipient) => [
      recipient.pubkey,
      session.names?.lookup(recipient.pubkey, candidates, displayFacts)
        ?.qualifier,
    ]),
  );
  const labels = new Map(
    draft.recipients.map((recipient) => [
      recipient.pubkey,
      resolveName(recipient.pubkey, recipient.name, candidates, displayFacts),
    ]),
  );
  const previous = useRef(labels);
  const revealed = useRef(
    new Set([...qualifiers].filter(([, suffix]) => suffix).map(([key]) => key)),
  );
  useLayoutEffect(() => {
    previous.current = labels;
    if (!draft.text) revealed.current.clear();
    for (const [key, suffix] of qualifiers)
      if (suffix) revealed.current.add(key);
  });
  function decorationsFor(draft: MentionDraft) {
    const doc = readComposerSnapshot(draft.document);
    const context = doc
      ? composerMarkdownContext(doc)
      : { text: draft.text, protected: [] };
    const { tree, tooDeep } = scanMarkdown(context.text);
    const literals: { start: number; end: number }[] = [...context.protected];
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (
        [
          "code",
          "inlineCode",
          "image",
          "imageReference",
          "definition",
          "html",
        ].includes(node.type)
      ) {
        const start = node.position?.start.offset,
          end = node.position?.end.offset;
        if (start !== undefined && end !== undefined)
          literals.push({ start, end });
      } else pending.push(...(node.children ?? []));
    }
    const ranges: {
      start: number;
      end: number;
      mention?: string;
      editAsText?: boolean;
    }[] = [];
    const add = (
      start: number,
      end: number,
      mention?: string,
      editAsText = false,
    ) => {
      if (
        // Explicit recipients disclose notification intent even inside Markdown literals.
        (mention ||
          (!tooDeep &&
            !literals.some(
              (range) => start < range.end && end > range.start,
            ))) &&
        !ranges.some((range) => start < range.end && end > range.start)
      )
        ranges.push({
          start,
          end,
          editAsText,
          ...(mention ? { mention } : {}),
        });
    };
    for (const recipient of draft.recipients)
      add(recipient.start, recipient.end, recipient.pubkey);
    messageLinkParts(context.text, undefined, (start, end) =>
      add(start, end, undefined, true),
    );
    for (const reference of messageReferences(
      context.text,
      [],
      profiles,
      directory.channels,
      directory.agents,
    ))
      add(reference.start, reference.end, undefined, true);
    const renderableEmoji = emoji.filter((entry) => !!session.media(entry.url));
    const shortcodes = new Set(
      renderableEmoji.map((entry) => entry.shortcode.toLowerCase()),
    );
    for (const match of context.text.matchAll(/:([a-z0-9_-]{1,64}):/gi))
      if (shortcodes.has(match[1]?.toLowerCase() ?? ""))
        add(match.index, match.index + match[0].length);
    const decorations = ranges
      .sort((a, b) => a.start - b.start)
      .map(({ start, end, mention, editAsText }) => {
        const label = draft.text.slice(start + 1, end);
      const resolved = mention ? (labels.get(mention) ?? label) : label;
      const qualifier = mention ? qualifiers.get(mention) : undefined;
      const faceLabel = qualifier
        ? resolved.slice(0, -(qualifier.length + 3))
        : resolved;
        return {
          start,
          end,
          editAsText: !!editAsText,
          content: mention ? (
            <InlineChip
              address={{
                kind:
                  directory.profiles.get(mention)?.isAgent ||
                  directory.agents.some((agent) => agent.pubkey === mention)
                    ? "agent"
                    : "person",
                id: mention,
              }}
              face={{
                label: faceLabel,
                loading: false,
                resolved: true,
              }}
              qualifier={
                qualifier
                  ? {
                      text: `· ${qualifier}`,
                      reveal:
                        previous.current.has(mention) &&
                        previous.current.get(mention) !== resolved &&
                        !revealed.current.has(mention),
                      accessibleLabel: `public key ending ${qualifier.split("").join(" ")}`,
                    }
                  : undefined
              }
              interactive={false}
            />
          ) : (
            <MessageMarkdown
              row={{
                id: "composer",
                authorId: "",
                createdAt: 0,
                channelId,
                content: draft.text.slice(start, end),
                mentions: mention ? [mention] : [],
                emoji: renderableEmoji,
                participants: [],
                attachments: [],
                reactions: [],
                replyCount: 0,
              }}
              directory={directory}
              participantProfiles={profiles}
              session={session}
              scope={scope}
              extensions={extensions}
              media={session.media}
              onOpenLink={() => false}
              interactive={false}
            />
          ),
        };
      });
    return decorations;
  }
  return (
    <EditableInput {...input} draft={draft} decorationsFor={decorationsFor} />
  );
}
