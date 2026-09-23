import { useLayoutEffect, useMemo, useRef } from "react";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";
import type { ConversationExtensions } from "../conversation/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import { scanMarkdown } from "../relay/message-content";
import { MessageMarkdown } from "./MessageMarkdown";
import type { MentionDraft } from "./mention-draft";
import { useReferenceDirectory } from "./ReferenceText";
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
  ...input
}: EditableInputProps & {
  draft: MentionDraft;
  session: RelaySession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  emoji: readonly CustomEmoji[];
}) {
  const directory = useReferenceDirectory(session);
  const profiles = new Map(directory.profiles);
  for (const recipient of draft.recipients)
    profiles.set(recipient.pubkey, {
      ...profiles.get(recipient.pubkey),
      name: recipient.name,
    });
  const qualifiers = useMemo(() => {
    // Presentation groups authored names, never resolves notification identity.
    const nameKeys = new Map<string, Set<string>>();
    for (const recipient of draft.recipients) {
      const name = draft.text
        .slice(recipient.start + 1, recipient.end)
        .trim()
        .toLowerCase();
      const keys = nameKeys.get(name) ?? new Set<string>();
      keys.add(recipient.pubkey);
      nameKeys.set(name, keys);
    }
    const result = new Map<string, ReadonlyMap<string, string>>();
    for (const [name, keys] of nameKeys)
      if (keys.size > 1) result.set(name, publicKeyLabels(keys));
    return result;
  }, [draft]);
  const previous = useRef({ draft, qualifiers });
  // Composer is keyed by draft destination. Restored qualifiers start at rest.
  const revealed = useRef(
    new Set(
      [...qualifiers].flatMap(([name, keys]) =>
        [...keys.keys()].map((key) => `${name}:${key}`),
      ),
    ),
  );
  const reveal = useMemo(() => {
    const reveal = new Set<string>();
    if (previous.current.draft !== draft) {
      for (const recipient of previous.current.draft.recipients) {
        const name = previous.current.draft.text
          .slice(recipient.start + 1, recipient.end)
          .trim()
          .toLowerCase();
        const identity = `${name}:${recipient.pubkey}`;
        if (
          !previous.current.qualifiers.has(name) &&
          qualifiers.has(name) &&
          !revealed.current.has(identity)
        )
          reveal.add(identity);
      }
    }
    return reveal;
  }, [draft, qualifiers]);
  useLayoutEffect(() => {
    previous.current = { draft, qualifiers };
    if (!draft.text) revealed.current.clear();
    // A qualifier shown at rest is already revealed too; either namesake may be removed.
    for (const [name, keys] of qualifiers)
      for (const key of keys.keys()) revealed.current.add(`${name}:${key}`);
  });
  const { tree, tooDeep } = scanMarkdown(draft.text);
  const literals: { start: number; end: number }[] = [];
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
          !literals.some((range) => start < range.end && end > range.start))) &&
      !ranges.some((range) => start < range.end && end > range.start)
    )
      ranges.push({ start, end, editAsText, ...(mention ? { mention } : {}) });
  };
  for (const recipient of draft.recipients)
    add(recipient.start, recipient.end, recipient.pubkey);
  messageLinkParts(draft.text, undefined, (start, end) =>
    add(start, end, undefined, true),
  );
  for (const reference of messageReferences(
    draft.text,
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
  for (const match of draft.text.matchAll(/:([a-z0-9_-]{1,64}):/gi))
    if (shortcodes.has(match[1]?.toLowerCase() ?? ""))
      add(match.index, match.index + match[0].length);
  const decorations = ranges
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, mention, editAsText }) => {
      const label = draft.text.slice(start + 1, end);
      const qualifier = mention
        ? qualifiers.get(label.trim().toLowerCase())?.get(mention)
        : undefined;
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
              label,
              loading: false,
              resolved: true,
            }}
            qualifier={
              qualifier
                ? {
                    text: `· ${qualifier}`,
                    reveal: reveal.has(
                      `${label.trim().toLowerCase()}:${mention}`,
                    ),
                    accessibleLabel: `public key ending ${qualifier.slice("npub…".length).split("").join(" ")}`,
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
  return <EditableInput {...input} decorations={decorations} />;
}
