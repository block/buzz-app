import { useMemo } from "react";
import { useChannelIdentityNames } from "../identity-names/react";
import { plainText, sourceEnd } from "../notifications/content";
import { profileKey } from "../profiles/target";
import { PROFILE_CACHE_BASE } from "../relay/budget";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { MatchedLabel } from "../search/MatchedLabel";
import referenceStyles from "../../shared/InlineReference.module.css";
import { normalizeWrappedLinks } from "./message-link-parts";
import { renderedProfileMentionParts } from "./profile-mentions";
import { MentionLabel, useReferenceDirectory } from "./ReferenceText";

/** A message as its previews bind it: its body and signed identities. */
export type PreviewMentions = Pick<
  ChannelMessage,
  "content" | "mentions" | "mentionReferences" | "edited" | "attachmentSeams"
>;

type Part = ReturnType<typeof renderedProfileMentionParts>[number];

/** Every identity a preview may name, for reading their profiles. */
export const mentionedIds = (mentioned: PreviewMentions) => [
  ...mentioned.mentions,
  ...(mentioned.mentionReferences ?? []),
];

/** `ids`, then the identities `mentioned` previews name, within the profile
 * directory's default budget: a request over it reads nobody. */
export const withMentionedIds = (
  ids: readonly string[],
  mentioned: readonly PreviewMentions[],
) => {
  const named = new Set(ids);
  return [...new Set([...named, ...mentioned.flatMap(mentionedIds)])].slice(
    0,
    Math.max(named.size, PROFILE_CACHE_BASE),
  );
};

/**
 * `parts` bound on `raw` after wrapped-link repair, placed back on `raw`,
 * which previews flatten. Repair is the only rewrite, and a reference inside
 * a repaired link is literal; undefined where the repair cannot be retraced.
 */
function rawParts(raw: string, parts: Part[]): Part[] | undefined {
  const repaired = parts.map((part) => part.text).join("");
  if (repaired === raw) return parts;
  // Each repaired link: its raw start and end and its repaired start and end.
  const edits: [number, number, number, number][] = [];
  let [rawAt, at] = [0, 0];
  normalizeWrappedLinks(raw, (start, end) => {
    at += start - rawAt;
    const source = raw.slice(start, end);
    const link = normalizeWrappedLinks(source, () => false);
    const applied = link !== source && repaired.startsWith(link, at);
    if (applied) edits.push([start, end, at, at + link.length]);
    at += applied ? link.length : source.length;
    rawAt = end;
    return true;
  });
  let rebuilt = "";
  rawAt = 0;
  for (const [start, end, from, to] of edits) {
    rebuilt += raw.slice(rawAt, start) + repaired.slice(from, to);
    rawAt = end;
  }
  if (rebuilt + raw.slice(rawAt) !== repaired) return undefined;
  const placed: Part[] = [];
  let [offset, plain, shift] = [0, 0, 0];
  for (const part of parts) {
    const start = offset;
    offset += part.text.length;
    let edit = edits[0];
    while (edit && edit[3] <= start) {
      shift += edit[1] - edit[0] - (edit[3] - edit[2]);
      edits.shift();
      edit = edits[0];
    }
    if (!part.target || (edit && edit[2] < offset)) continue;
    if (start + shift > plain)
      placed.push({ text: raw.slice(plain, start + shift) });
    placed.push(part);
    plain = offset + shift;
  }
  if (plain < raw.length) placed.push({ text: raw.slice(plain) });
  return placed;
}

// Private-use marks around a reference's interior, then its index.
const OPEN = "\uE010";
const CLOSE = "\uE011";
const INDEX = 0xe100;
const MARKS = /\uE010[\uE100-\uF8FF]?|\uE011/gu;

/**
 * The conversation's `parts` of a body, flattened as preview text is. Each
 * reference's interior is marked before flattening, keeping its first and
 * last characters so the Markdown around it parses alike. A reference keeps
 * its place only where its marks and characters come through whole and in
 * order; Markdown, code or a spoiler that changes it leaves it literal.
 * The body is cut where flattening cuts it before marking, so marks cannot
 * move the cut; a reference the cut splits is text.
 */
function flatParts(parts: Part[]): Part[] {
  const body = parts.map((part) => part.text).join("");
  const end = sourceEnd(body);
  const references: Part[] = [];
  let offset = 0;
  const marked = parts
    .map((part) => {
      const at = offset;
      offset += part.text.length;
      if (at >= end) return "";
      if (!part.target || offset > end) return part.text.slice(0, end - at);
      const chars = [...part.text];
      const index = String.fromCharCode(INDEX + references.push(part) - 1);
      return `${chars[0]}${OPEN}${index}${chars.slice(1, -1).join("")}${CLOSE}${chars.at(-1)}`;
    })
    .join("");
  const flat = plainText(marked, {
    limit: Number.POSITIVE_INFINITY,
    presliced: { truncated: body.length > end },
  });
  const shown: Part[] = [];
  let plain = "";
  let next = 0;
  for (let at = 0; at < flat.length; ) {
    const index = flat.charCodeAt(at + 1) - INDEX;
    const part =
      flat[at] === OPEN && index >= next ? references[index] : undefined;
    if (part && plain.endsWith(part.text[0] ?? "")) {
      const chars = [...part.text];
      const rest = `${chars.slice(1, -1).join("")}${CLOSE}${chars.at(-1)}`;
      if (flat.startsWith(rest, at + 2)) {
        plain = plain.slice(0, -1);
        if (plain) shown.push({ text: plain });
        shown.push(part);
        plain = "";
        next = index + 1;
        at += 2 + rest.length;
        continue;
      }
    }
    plain += flat[at];
    at++;
  }
  if (plain) shown.push({ text: plain });
  return shown.map((part) =>
    part.target ? part : { text: part.text.replace(MARKS, "") },
  );
}

/**
 * The conversation's `parts` of a message body, cut to `text`. `text` shows
 * `full` from `start`, after a leading "…" when `start` is past its first
 * character, and may end with "…" where it was cut. `full` must be the body
 * flattened, or a prefix of that ended with "…"; otherwise, or without
 * references, this is undefined. A reference a cut splits stays literal.
 */
function previewParts(
  parts: Part[],
  full: string,
  text: string,
  start: number,
): Part[] | undefined {
  if (!parts.some((part) => part.target)) return undefined;
  const flat = flatParts(parts);
  const source = flat.map((part) => part.text).join("");
  const usable =
    full === source
      ? full
      : full.endsWith("…") && source.startsWith(full.slice(0, -1))
        ? full.slice(0, -1)
        : undefined;
  const opened = start > 0 ? "…" : "";
  if (usable === undefined || !text.startsWith(opened)) return undefined;
  const shown = text.slice(opened.length);
  const length = usable.startsWith(shown, start)
    ? shown.length
    : shown.endsWith("…") && usable.startsWith(shown.slice(0, -1), start)
      ? shown.length - 1
      : -1;
  if (length < 0) return undefined;
  const [from, to] = [start, start + length];
  const cut: Part[] = opened ? [{ text: opened }] : [];
  let offset = 0;
  for (const part of flat) {
    const at = offset;
    offset += part.text.length;
    const [cutFrom, cutTo] = [Math.max(at, from), Math.min(offset, to)];
    if (cutFrom >= cutTo) continue;
    cut.push(
      cutFrom === at && cutTo === offset
        ? part
        : { text: part.text.slice(cutFrom - at, cutTo - at) },
    );
  }
  if (length < shown.length) cut.push({ text: "…" });
  return cut;
}

/** Flattened preview text with its signed mentions as chips, bound and
 * labelled as its message binds them. `text` shows `full` (itself by
 * default) from `start`, as `previewParts` describes. `matches` are the code
 * points MatchedLabel marks in `text`; a chip holding one is marked whole,
 * since its label can differ from its text. */
export function PreviewText({
  text,
  full = text,
  start = 0,
  mentions,
  matches,
  session,
  channelId,
}: {
  text: string;
  full?: string | undefined;
  start?: number | undefined;
  mentions: PreviewMentions;
  matches?: readonly number[] | undefined;
  session: RelaySession | undefined;
  channelId: string | undefined;
}) {
  const directory = useReferenceDirectory(session);
  const resolveName = useChannelIdentityNames(session, channelId);
  // Flattening parses the body's Markdown; do it once per body and directory.
  const parts = useMemo(() => {
    // Only signed, unedited bodies bind; skip preparing the rest.
    if (mentions.edited || !mentionedIds(mentions).length) return [{ text }];
    // Only the binder's fields, as the conversation passes them.
    const message = {
      content: mentions.content,
      mentions: mentions.mentions,
      ...(mentions.mentionReferences
        ? { mentionReferences: mentions.mentionReferences }
        : {}),
      ...(mentions.attachmentSeams
        ? { attachmentSeams: mentions.attachmentSeams }
        : {}),
    };
    const bound = renderedProfileMentionParts(
      message,
      directory.profiles,
      directory.agents,
    );
    const placed = rawParts(mentions.content, bound);
    return (placed && previewParts(placed, full, text, start)) ?? [{ text }];
  }, [mentions, directory.profiles, directory.agents, full, text, start]);
  // Code points before each part, as `matches` count them.
  let point = 0;
  return parts.map((part) => {
    const start = point;
    const length = [...part.text].length;
    point += length;
    const positions = matches
      ?.filter((at) => at >= start && at < start + length)
      .map((at) => at - start);
    const key = part.target && profileKey(part.target);
    if (!key)
      return (
        <MatchedLabel key={start} label={part.text} positions={positions} />
      );
    // A namesake-qualified span shows its name, as a message shows it.
    const label = resolveName(
      key,
      part.text.slice(1).replace(/ \([a-f0-9]{64}\)$/i, ""),
    );
    const agent =
      directory.agents.some((entry) => entry.pubkey === key) ||
      !!directory.profiles.get(key)?.isAgent;
    const chip = (
      <span
        key={start}
        className={referenceStyles.link}
        data-mention-kind={agent ? "agent" : "person"}
        data-mention-self={key === session?.viewer ? "" : undefined}
        data-profile-target={part.target}
        data-mention-name={label}
      >
        <MentionLabel agent={agent} label={label} />
      </span>
    );
    return positions?.length ? (
      <mark key={start} className="search-match">
        {chip}
      </mark>
    ) : (
      chip
    );
  });
}
