import {
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { WelcomeMessage } from "../../features/communities/WelcomeCard";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { ComposerFormattingTools } from "../../features/messages/ComposerFormattingTools";
import { ComposerLinkDialog } from "../../features/messages/ComposerLinkDialog";
import {
  composerMarkdownContext,
  markdownRanges,
  readComposerSnapshot,
  type SourceRange,
} from "../../features/messages/composer-document";
import type {
  ComposerFormat,
  ComposerInputElement,
  ComposerLinkEdit,
} from "../../features/messages/composer-dom";
import { composerMarkdown } from "../../features/messages/composer-markdown";
import {
  EditableInput,
  type EditorDecoration,
} from "../../features/messages/EditableInput";
import {
  mentionDraft,
  type MentionDraft,
} from "../../features/messages/mention-draft";
import { profileMentionLink } from "../../features/messages/message-edit";
import { messageLinkParts } from "../../features/messages/message-link-parts";
import { profileKey } from "../../features/profiles/target";
import { WELCOME_MAX_LENGTH } from "../../features/relay/landing";
import { scanMarkdown } from "../../features/relay/message-content";
import type { RelaySession } from "../../features/relay/session";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Field } from "../../shared/design-system/ui/Field";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import styles from "./WelcomeMessageEditor.module.css";

const noOpen = () => false;
/** Chip artwork whose props hold across keystrokes, so typing prose does not
 * re-render every link in the message. */
const LinkToken = memo(WelcomeMessage);

/**
 * Identity, channel, message and web links outside code: the spans the editor
 * shows as chips, as the composer does. This is deliberately narrower than
 * `RichComposerInput`'s `decorationsFor`: plain `#name` and `@Name`
 * references and `:shortcode:` emoji are not chips. The card renders
 * through `MessageMarkdown`, so it may show a reference that stays plain
 * text here.
 */
function linkRanges(text: string, rich: readonly SourceRange[]) {
  const blocked = [...rich, ...markdownRanges(text).literal];
  const ranges: SourceRange[] = [];
  const add = (start: number, end: number) => {
    if (
      ![...blocked, ...ranges].some(
        (range) => start < range.end && end > range.start,
      )
    )
      ranges.push({ start, end });
  };
  for (const link of scanMarkdown(text).links) {
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (
      link.url &&
      profileKey(link.url) &&
      start !== undefined &&
      end !== undefined
    )
      add(start, end);
  }
  messageLinkParts(text, undefined, add);
  return ranges.sort((a, b) => a.start - b.start);
}

/** Where a paste lands: over `start`–`end` of the draft text `source`. */
type PasteAt = SourceRange & { source: string };

/** Whether `text`, pasted as is, stands alone in prose: at the start of the
 * draft or after whitespace, at its end or before whitespace, and not inside
 * Markdown code or a link. A paste joined to other text, such as an unclosed
 * code span, a bare URL or a link destination being typed, does not. */
function pastedAlone(text: string, { source, start, end }: PasteAt) {
  const before = source.slice(0, start);
  const rest = source.slice(end);
  if (!/(^|\s)$/.test(before) || !/^(\s|$)/.test(rest)) return false;
  const after = before + text + rest;
  const pasted = { start, end: start + text.length };
  const spans = [
    ...markdownRanges(after).literal,
    ...scanMarkdown(after).links.map(({ position }) => ({
      start: position?.start.offset ?? 0,
      end: position?.end.offset ?? 0,
    })),
  ];
  return !spans.some(
    (span) => pasted.start > span.start && pasted.end < span.end,
  );
}

/**
 * A pasted npub, bare as Copy npub writes it or as a `nostr:` URI, becomes an
 * identity link labelled with the person's name when it is known, so it shows
 * as a chip. Like every identity link here, it notifies no one. Pasted into
 * Markdown code or a link, or joined to other text, it stays as pasted.
 */
function identityPaste(
  text: string,
  at: PasteAt,
  names: RelaySession["names"],
) {
  const npub = text.trim().replace(/^nostr:/, "");
  const target = `nostr:${npub}`;
  const pubkey = profileKey(target);
  if (!pubkey || !pastedAlone(text, at)) return text;
  const name = names?.resolve(pubkey) ?? formatPublicKey(pubkey) ?? npub;
  return profileMentionLink(`@${name}`, target);
}

/**
 * The welcome message in the composer's editor, with its formatting toolbar,
 * shortcuts and link dialog. The value is Markdown source, as the relay stores
 * it: formatting applied here is written as the composer sends it, and
 * published Markdown opens as its source and is sent back unchanged. There
 * are no recipients, so identity links, pasted npubs included, only name
 * people.
 */
export function WelcomeMessageEditor({
  ref,
  label,
  description,
  error,
  value,
  onChange,
  disabled,
  session,
  scope,
  channelId,
  extensions,
}: {
  ref: RefObject<ComposerInputElement | null>;
  label: string;
  description: ReactNode;
  error?: string | undefined;
  /** Markdown source. */
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  session: RelaySession;
  scope: string;
  /** Scopes the names identity chips show to this channel's members. */
  channelId: string;
  /** The link renderers messages use, so chips here look as the card's links do. */
  extensions: ConversationExtensions | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => mentionDraft(value));
  // The Markdown the editor shows, to tell its own changes from new values.
  const shown = useRef(value);
  const [formats, setFormats] = useState<readonly ComposerFormat[]>([]);
  const [linkEdit, setLinkEdit] = useState<ComposerLinkEdit | null>(null);
  const [pasteTooLong, setPasteTooLong] = useState(false);
  const links = useRef<{ text: string; ranges: readonly SourceRange[] }>(
    undefined,
  );
  // A value from elsewhere (the published text, Cancel, Restore defaults)
  // replaces the document; undo starts again from it.
  useLayoutEffect(() => {
    if (value === shown.current) return;
    const next = mentionDraft(value);
    shown.current = value;
    ref.current?.reset(next);
    setDraft(next);
    setPasteTooLong(false);
  }, [value, ref]);
  const decorationsFor = (next: MentionDraft): EditorDecoration[] => {
    const doc = readComposerSnapshot(next.document);
    const context = doc
      ? composerMarkdownContext(doc)
      : { text: next.text, protected: [] };
    if (links.current?.text !== context.text)
      links.current = {
        text: context.text,
        ranges: linkRanges(context.text, context.protected),
      };
    return links.current.ranges.map(({ start, end }) => ({
      start,
      end,
      editAsText: true,
      content: (
        <LinkToken
          message={next.text.slice(start, end)}
          session={session}
          scope={scope}
          channelId={channelId}
          extensions={extensions}
          onOpenLink={noOpen}
          interactive={false}
        />
      ),
    }));
  };
  const problem =
    error ??
    (pasteTooLong
      ? "This paste would make the message too long. Shorten the text and try again."
      : undefined);
  return (
    <>
      <Field
        label={<span id={`${id}-label`}>{label}</span>}
        nativeLabel={false}
        description={<span id={`${id}-description`}>{description}</span>}
        error={problem && <span id={`${id}-error`}>{problem}</span>}
      >
        <InputGroup>
          <div className={`${styles.frame} text-body`}>
            <EditableInput
              ref={ref}
              draft={draft}
              value={draft.text}
              disabled={disabled}
              placeholder="Write a welcome message"
              aria-labelledby={`${id}-label`}
              aria-describedby={problem ? `${id}-error` : `${id}-description`}
              aria-invalid={!!problem || undefined}
              // The editor counts UTF-16 units and the relay counts characters,
              // at most two units each: this never refuses a message the relay
              // accepts, and the field's own check reports the real limit.
              maxLength={2 * WELCOME_MAX_LENGTH}
              decorationsFor={decorationsFor}
              onDraftChange={(next) => {
                setDraft(next);
                setPasteTooLong(false);
                const markdown = composerMarkdown(next);
                if (markdown === shown.current) return;
                shown.current = markdown;
                onChange(markdown);
              }}
              onFormatsChange={setFormats}
              onEditLink={setLinkEdit}
              onPasteTooLong={() => setPasteTooLong(true)}
              pastedText={(text, at) => identityPaste(text, at, session.names)}
            />
            <ComposerFormattingTools
              disabled={disabled}
              activeFormats={formats}
              toggleFormat={(format) => ref.current?.toggleFormat(format)}
              editLink={() => {
                const edit = ref.current?.editLink();
                if (edit) setLinkEdit(edit);
              }}
            >
              {null}
            </ComposerFormattingTools>
          </div>
        </InputGroup>
      </Field>
      {linkEdit && (
        <ComposerLinkDialog
          edit={linkEdit}
          input={ref}
          disabled={disabled}
          close={() => setLinkEdit(null)}
        />
      )}
    </>
  );
}
