import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChannelIdentityNames } from "../identity-names/react";
import { plainText, sourceEnd, treeText } from "../notifications/content";
import { profileKey } from "../profiles/target";
import { PROFILE_CACHE_BASE } from "../relay/budget";
import type { ChannelMessage, Profile } from "../relay/contracts";
import {
  projectMarkdownAttachments,
  scanMarkdown,
} from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import { MatchedLabel } from "../search/MatchedLabel";
import { prepareMarkdown, recentResults } from "./markdown-preparation";
import { normalizeWrappedLinks } from "./message-link-parts";
import type { AgentLibrary } from "../agents/library";
import {
  profileMentionNames,
  renderedProfileMentionParts,
} from "./profile-mentions";
import { ProfileMention, useReferenceDirectory } from "./ReferenceText";

/** A message as its previews bind it: its body and signed identities.
 * `attachmentUrls` marks a source body the conversation projects first:
 * its images and these attachment links are removed before binding. */
export type PreviewMentions = Pick<
  ChannelMessage,
  "content" | "mentions" | "mentionReferences" | "edited" | "attachmentSeams"
> & { attachmentUrls?: ReadonlySet<string> | undefined };

type Part = ReturnType<typeof renderedProfileMentionParts>[number];
type Tree = ReturnType<typeof scanMarkdown>["tree"];

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

/** Rewrites of a raw body: each one's raw start and end and its start and
 * end in the rewritten body. */
type Edit = [number, number, number, number];

/** `parts` of a rewritten body placed back on `raw`. A reference that
 * overlaps a rewrite is dropped to text. */
function place(raw: string, parts: Part[], edits: Edit[]): Part[] {
  const placed: Part[] = [];
  let [offset, plain, shift, next] = [0, 0, 0, 0];
  for (const part of parts) {
    const start = offset;
    offset += part.text.length;
    let edit = edits[next];
    while (edit && edit[3] <= start) {
      shift += edit[1] - edit[0] - (edit[3] - edit[2]);
      edit = edits[++next];
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

/**
 * `parts` bound on `raw` after wrapped-link repair, placed back on `raw`.
 * Repair is the only rewrite, and a reference inside a repaired link is
 * literal; undefined where the repair cannot be retraced.
 */
function rawParts(raw: string, parts: Part[]): Part[] | undefined {
  const repaired = parts.map((part) => part.text).join("");
  if (repaired === raw) return parts;
  const edits: Edit[] = [];
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
  return place(raw, parts, edits);
}

// What the binder reads past a name's start: "@", the name, a namesake
// qualifier " (<64 hex>)" and one boundary character.
const QUALIFIED = 1 + 68 + 1;

/** `at`, or one before it where it would split a surrogate pair. */
const pointEnd = (content: string, at: number) => {
  const code = content.charCodeAt(at - 1);
  return at < content.length && code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
};

/** Each signed identity and the names it binds by, as the binder lists
 * them from profiles and agents. */
type Labels = { id: string; names: string[] }[];

const longestName = (labels: Labels) =>
  Math.max(
    0,
    ...labels.flatMap(({ names }) => names.map((name) => name.length)),
  );

/** How much of `content` binding can read for `labels`. */
const readEnd = (content: string, labels: Labels) =>
  sourceEnd(content) + longestName(labels) + QUALIFIED;

function mentionLabels(
  ids: readonly string[],
  profiles: ReadonlyMap<string, Profile>,
  agents: AgentLibrary["identities"],
): Labels {
  return [...new Set(ids)].map((id) => ({
    id,
    names: [
      ...profileMentionNames(profiles.get(id)),
      ...agents
        .filter((agent) => agent.pubkey === id)
        .map((agent) => agent.name),
    ].filter((name): name is string => !!name),
  }));
}

/**
 * The conversation's parts of `mentions`, on `raw`: its body up to `end`
 * and room past it for the binder to finish the longest name that can start
 * before it, with `raw`'s parsed tree when one was made. A source body is
 * projected as the conversation projects it, and the parts placed back on
 * the source. When the body was cut, a reference directly before an image or
 * link the cut may have left open stays text, since the whole body may
 * remove it and join different text to the name.
 */
function boundParts(
  raw: string,
  mentions: {
    content: string;
    attachmentSeams: readonly number[] | undefined;
    attachmentUrls: ReadonlySet<string> | undefined;
  },
  labels: Labels,
): { parts: Part[]; tree: Tree | undefined } | undefined {
  const urls = mentions.attachmentUrls;
  const scan =
    urls && (raw.includes("![") || urls.size) ? scanMarkdown(raw) : undefined;
  const projected =
    urls && scan ? projectMarkdownAttachments(raw, urls, scan) : undefined;
  const body = projected?.content ?? raw;
  const seams = (projected?.seams ?? mentions.attachmentSeams ?? []).filter(
    (seam) => seam < body.length,
  );
  // Unprojected, the binder's parse of `raw` is the one flattening reads.
  let tree = scan?.tooDeep ? undefined : scan?.tree;
  const prepared = projected
    ? undefined
    : prepareMarkdown(body, (bodyScan) => {
        tree = bodyScan.tree;
      });
  if (prepared && prepared.content !== raw) tree = undefined;
  const parts = rawParts(
    body,
    renderedProfileMentionParts(
      {
        content: body,
        mentions: labels.map((label) => label.id),
        mentionLabels: labels,
        ...(seams.length ? { attachmentSeams: seams } : {}),
      },
      undefined,
      [],
      prepared,
    ),
  );
  if (!parts || !projected) return parts && { parts, tree };
  const edits: Edit[] = [];
  let removed = 0;
  for (const { start, end } of projected.removed) {
    edits.push([start, end, start - removed, start - removed]);
    removed += end - start;
  }
  const placed = place(raw, parts, edits);
  if (raw.length === mentions.content.length) return { parts: placed, tree };
  let offset = 0;
  const shown = placed.map((part) => {
    offset += part.text.length;
    const end = offset;
    const open =
      part.target &&
      /^!?\[/.test(raw.slice(end, end + 2)) &&
      !projected.removed.some((range) => range.start === end);
    return open ? { text: part.text } : part;
  });
  return { parts: shown, tree };
}

// Private-use marks around a reference's interior, then its index. The
// opening and closing marks are ones the body does not contain.
const INDEX = 0xe100;
// Whitespace and controls as the flattener collapses them.
const flatSpaces = (value: string) =>
  value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").replace(/\s+/gu, " ");

/** A reference as it reads flattened, its interior's spaces collapsed. */
const flatChip = (text: string) => {
  const chars = [...text];
  return `${chars[0]}${flatSpaces(chars.slice(1, -1).join(""))}${chars.at(-1)}`;
};

/** Whether `text` can show a chip for `labels`: one reads as its name, or
 * with a namesake qualifier, which may differ in case. */
const mayName = (text: string, labels: Labels) =>
  / \([a-f0-9]{64}\)/i.test(text) ||
  labels.some(({ names }) =>
    names.some((name) => text.includes(flatChip(`@${name}`))),
  );

/** Puts each marked reference in the text node of `tree` that holds it
 * verbatim, so flattening the tree reads its marks where it reads. A
 * reference no such node holds is left unmarked, as text. */
function markTree(
  tree: Tree,
  source: string,
  marked: readonly { at: number; length: number; text: string }[],
) {
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    pending.push(...(node.children ?? []));
    const [start, end] = [
      node.position?.start.offset,
      node.position?.end.offset,
    ];
    if (
      node.type !== "text" ||
      start === undefined ||
      end === undefined ||
      node.value !== source.slice(start, end)
    )
      continue;
    let value = node.value;
    for (const { at, length, text } of [...marked].reverse())
      if (at >= start && at + length <= end)
        value =
          value.slice(0, at - start) + text + value.slice(at + length - start);
    node.value = value;
  }
}

/**
 * The conversation's `parts` of a body, flattened as preview text is. Each
 * reference's interior is marked, keeping its first and last characters. A
 * reference keeps its place only where its marks and characters come through
 * whole and in order; Markdown, code or a spoiler that changes it leaves it
 * literal. With the body's parsed `tree`, the marks go into its prose text
 * in place and the tree is flattened without parsing again. Otherwise the body is cut where flattening cuts it, marked so the Markdown
 * around each reference parses alike, and flattened; marks cannot move the
 * cut. A reference past `end` is text.
 */
function flatParts(
  parts: Part[],
  end: number,
  truncated: boolean,
  tree: Tree | undefined,
): Part[] | undefined {
  const body = parts.map((part) => part.text).join("");
  const free: string[] = [];
  for (let code = 0xe000; code < INDEX && free.length < 2; code++)
    if (!body.includes(String.fromCharCode(code)))
      free.push(String.fromCharCode(code));
  const [OPEN, CLOSE] = free;
  if (!OPEN || !CLOSE) return undefined;
  const marks = new RegExp(`${OPEN}[\uE100-\uF8FF]?|${CLOSE}`, "gu");
  const references: Part[] = [];
  const marked: { at: number; length: number; text: string }[] = [];
  let offset = 0;
  for (const part of parts) {
    const at = offset;
    offset += part.text.length;
    if (!part.target || offset > end) continue;
    const chars = [...part.text];
    const index = String.fromCharCode(INDEX + references.push(part) - 1);
    const text = `${chars[0]}${OPEN}${index}${chars.slice(1, -1).join("")}${CLOSE}${chars.at(-1)}`;
    marked.push({ at, length: part.text.length, text });
  }
  let flat: string;
  if (tree && !body.includes("||")) {
    markTree(tree, body, marked);
    flat = treeText(tree, Number.POSITIVE_INFINITY);
  } else {
    let source = "";
    let from = 0;
    for (const { at, length, text } of marked) {
      source += body.slice(from, at) + text;
      from = at + length;
    }
    flat = plainText(source + body.slice(from, end), {
      limit: Number.POSITIVE_INFINITY,
      presliced: { truncated },
    });
  }
  const shown: Part[] = [];
  let plain = "";
  let next = 0;
  for (let at = 0; at < flat.length; ) {
    const index = flat.charCodeAt(at + 1) - INDEX;
    const part =
      flat[at] === OPEN && index >= next ? references[index] : undefined;
    if (part && plain.endsWith(part.text[0] ?? "")) {
      const chars = [...part.text];
      const interior = flatSpaces(chars.slice(1, -1).join(""));
      const rest = `${interior}${CLOSE}${chars.at(-1)}`;
      if (flat.startsWith(rest, at + 2)) {
        plain = plain.slice(0, -1);
        if (plain) shown.push({ text: plain });
        shown.push({ ...part, text: flatChip(part.text) });
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
    part.target ? part : { text: part.text.replace(marks, "") },
  );
}

/**
 * The conversation's `parts` of a body up to `end`, flattened and cut to
 * `text`. `text` shows `full` from `start`, after a leading "…" when `start`
 * is past its first character, and may end with "…" where it was cut;
 * `full` is the whole body flattened, and may end with "…" where flattening
 * cut it. Undefined unless the flattened parts read as `full` up to the end
 * of `text`. A reference a cut splits stays literal.
 */
function previewParts(
  parts: Part[],
  end: number,
  truncated: boolean,
  full: string,
  text: string,
  start: number,
  tree: Tree | undefined,
): Part[] | undefined {
  const opened = start > 0 ? "…" : "";
  if (!text.startsWith(opened)) return undefined;
  const shown = text.slice(opened.length);
  let length = full.startsWith(shown, start)
    ? shown.length
    : shown.endsWith("…") && full.startsWith(shown.slice(0, -1), start)
      ? shown.length - 1
      : -1;
  if (length < 0) return undefined;
  const flat = flatParts(parts, end, truncated, tree);
  if (!flat) return undefined;
  const source = flat.map((part) => part.text).join("");
  // `full`'s own closing "…" is not body text.
  if (
    !source.startsWith(full.slice(0, start + length)) &&
    start + length === full.length &&
    full.endsWith("…")
  )
    length--;
  const [from, to] = [start, start + length];
  // The tree includes the binder's room past `end`, which can change how
  // the text before it reads: then flatten as `full` was, from `end`.
  if (!source.startsWith(full.slice(0, to)))
    return tree
      ? previewParts(parts, end, truncated, full, text, start, undefined)
      : undefined;
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

/**
 * `mentions`' parts as a preview showing `text` from `start` of `full`
 * shows them. Flattening reads from the body's start, so this binds and
 * flattens only a prefix about twice what the preview shows, and the
 * flattener's whole bound only when that prefix does not read as `full` up
 * to the end of `text`.
 */
function windowParts(
  mentions: Parameters<typeof boundParts>[1],
  labels: Labels,
  full: string,
  text: string,
  start: number,
): Part[] | undefined {
  const { content } = mentions;
  const longest = longestName(labels);
  const whole = sourceEnd(content);
  for (const limit of [2 * (start + text.length) + 256, whole]) {
    const end = pointEnd(content, Math.min(whole, limit));
    const raw = content.slice(0, pointEnd(content, end + longest + QUALIFIED));
    const bound = boundParts(raw, mentions, labels);
    const early = end < whole;
    if (!bound || (!early && !bound.parts.some((part) => part.target)))
      return undefined;
    const cut = previewParts(
      bound.parts,
      end,
      content.length > end,
      full,
      text,
      start,
      bound.tree,
    );
    if (cut || !early) return cut;
  }
  return undefined;
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
  const shown = useNearScreen();
  const { content, edited, attachmentSeams: seams } = mentions;
  const urls = mentions.attachmentUrls;
  // Binding reruns only when what it reads changes: the body and the names
  // its identities bind by, not every profile the directory loads.
  const labels = JSON.stringify(
    mentionLabels(mentionedIds(mentions), directory.profiles, directory.agents),
  );
  // Binding parses the body's Markdown up to what the preview shows, and
  // only for previews on or near the screen.
  const parts = useMemo(() => {
    if (!shown.near || edited || labels === "[]") return [{ text }];
    const message = { content, attachmentSeams: seams, attachmentUrls: urls };
    const parsed: Labels = JSON.parse(labels);
    if (!mayName(text, parsed)) return [{ text }];
    // Binding reads no further than `readEnd`; past it only the length counts.
    const key = JSON.stringify([
      labels,
      seams,
      urls && [...urls],
      content.length,
      content.slice(0, readEnd(content, parsed)),
      full,
      text,
      start,
    ]);
    return recentParts(
      key,
      () => windowParts(message, parsed, full, text, start) ?? [{ text }],
    );
  }, [shown.near, edited, labels, content, seams, urls, full, text, start]);
  // Code points before each part, as `matches` count them.
  let point = 0;
  const shownParts = parts.map((part) => {
    const start = point;
    const length = [...part.text].length;
    point += length;
    const positions = matches
      ?.filter((at) => at >= start && at < start + length)
      .map((at) => at - start);
    if (!part.target || !profileKey(part.target))
      return (
        <MatchedLabel key={start} label={part.text} positions={positions} />
      );
    const chip = (
      <ProfileMention
        key={start}
        text={part.text}
        target={part.target}
        profiles={directory.profiles}
        agents={directory.agents}
        viewer={session?.viewer}
        resolveName={resolveName}
      />
    );
    return positions?.length ? (
      <mark key={start} className="search-match">
        {chip}
      </mark>
    ) : (
      chip
    );
  });
  return <span ref={shown.ref}>{shownParts}</span>;
}

// Recent previews' parts, so a row shown again does not bind again.
const recentParts = recentResults<Part[]>(1_000_000, (key) => key.length);

// One observer for every preview still waiting to come near the screen.
const waiting = new Map<Element, () => void>();
let nearObserver: IntersectionObserver | undefined;
// Half a screen ahead, so chips are usually bound before a row shows.
const NEAR = 0.5;

/** Whether this preview has been on or near the screen. A preview there on
 * its first layout is bound before it paints; the rest bind as they near. */
function useNearScreen() {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useLayoutEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const rect = element.getBoundingClientRect();
    const margin = window.innerHeight * NEAR;
    if (rect.bottom >= -margin && rect.top <= window.innerHeight + margin) {
      setNear(true);
      return;
    }
    nearObserver ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const show = entry.isIntersecting && waiting.get(entry.target);
          if (!show) continue;
          waiting.delete(entry.target);
          nearObserver?.unobserve(entry.target);
          show();
        }
      },
      { rootMargin: `${NEAR * 100}% 0px` },
    );
    waiting.set(element, () => setNear(true));
    nearObserver.observe(element);
    return () => {
      waiting.delete(element);
      nearObserver?.unobserve(element);
    };
  }, [near]);
  return { ref, near };
}
