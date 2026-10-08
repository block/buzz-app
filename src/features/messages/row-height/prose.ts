import type { PhrasingContent, Root } from "mdast";
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Contribution } from "../../../plugins/contributions";
import type {
  InlineRenderer,
  LinkRenderer,
  MessageRenderer,
} from "../../conversation/contracts";
import { inlineMatches } from "../../conversation/InlineText";
import { resolveLink } from "../../conversation/MessageLink";
import { profileKey } from "../../profiles/target";
import type { ChannelMessage, Profile } from "../../relay/contracts";
import {
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_LENGTH,
} from "../../relay/message-content";
import { usesLargeEmojiPresentation } from "../emoji-size";
import { prepareMarkdown } from "../markdown-preparation";
import { parseMediaTimeReply } from "../media-timecode";
import { messageLinkParts } from "../message-link-parts";
import { messageReferences } from "../message-references";
import {
  protectInlineContent,
  remarkInlineContent,
  transformUrl,
} from "../MessageMarkdown";
import type { useReferenceDirectory } from "../ReferenceText";

type Directory = ReturnType<typeof useReferenceDirectory>;
/** Everything outside a row that its body's presentation reads, as
 * MessageRow and MessageMarkdown read them in ChannelTimeline. */
export type Inputs = Readonly<{
  messages: readonly Contribution<MessageRenderer>[];
  inline: readonly Contribution<InlineRenderer>[];
  links: readonly Contribution<LinkRenderer>[];
  profiles: ReadonlyMap<string, Profile>;
  channels: Directory["channels"];
  agents: Directory["agents"];
  canOpenLink?: ((target: string) => boolean) | undefined;
  resolveName(pubkey: string, fallback: string): string;
}>;
/** The fonts paragraph text renders in: strong and emphasis change them,
 * strikethrough does not. */
export type Style = "body" | "bold" | "italic" | "bold-italic";
/** An atomic inline box, never broken: a mention button (an icon beside its
 * label, `person` or `agent`), a custom `emoji`, or a link `chip`, whose width
 * only lies between none and its cap. */
export type Box = "person" | "agent" | "emoji" | "chip";
/** One DOM text node of a paragraph, or a box: a button's text is its label,
 * a chip's its destination. */
export type Run = Readonly<{ text: string; style: Style; box?: Box }>;
/** Paragraphs of `<br>`-separated segments of runs, exactly as
 * MessageMarkdown renders them. */
export type Prose = readonly (readonly (readonly Run[])[])[];
export type ProseReason =
  | "membership"
  | "diff"
  | "attachments"
  | "reactions"
  | "thread"
  | "sent-from-thread"
  | "workflow"
  | "delivery"
  | "mentions"
  | "plain-text"
  | "characters"
  | "spoiler"
  | "entity"
  | "link"
  | "link-renderer"
  | "time-reply"
  | "large-emoji"
  | "message-renderer"
  | "markdown"
  | "nested-strong"
  | "inline-renderer"
  | "empty";

// The renderer's own plugins: remark-gfm's parser extensions and remark-breaks.
const gfm: {
  micromarkExtensions?: Options["extensions"];
  fromMarkdownExtensions?: Options["mdastExtensions"];
} = {};
(remarkGfm as (this: unknown) => void).call({ data: () => gfm });
const breaks = remarkBreaks();
function parse(content: string): Root {
  const tree = fromMarkdown(content, {
    extensions: gfm.micromarkExtensions ?? [],
    mdastExtensions: gfm.fromMarkdownExtensions ?? [],
  });
  breaks(tree);
  return tree;
}

/** Renderers whose presentation the model knows: the shipped bundled code
 * (an external plugin cannot have that revision). Custom emoji are one fixed
 * box whatever their media; links render inside the host's chip with the
 * shared `.link` class (docs/channels.md). */
export const bundled = (entry: Contribution<object> | undefined, key: string) =>
  entry?.revision === "bundled" && entry.key === key;
export const EMOJI = "buzz.emoji/custom";
const LINKS = "buzz.links/links";

// Any character that can begin Markdown syntax (emphasis, code, links,
// images, HTML, autolinks, tables, headings, quotes, escapes, entities,
// strikethrough, GFM literal autolinks: `@`, `://`, `www.`), and controls.
const syntax =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: controls are rejected
  /[*_~`[\]<>#|\\&@\u0000-\u0009\u000b-\u001f\u007f-\u009f]|:\/\/|www\./i;
// A line that could start or end a block (indented code, lists, setext
// underlines, thematic breaks, hard breaks) or lose its edge whitespace.
const blockLine = /^(?:\s|[-+=]|\d+[.)])|\s$/u;
/** The paragraphs of content with no Markdown syntax, as the parse finds
 * them: blank lines end paragraphs, other line ends are `<br>`. Anything the
 * check cannot rule out is `undefined` and parsed. */
export function plainParagraphs(content: string): Prose | undefined {
  if (syntax.test(content)) return undefined;
  const paragraphs: Run[][][] = [];
  let paragraph: Run[][] | undefined;
  for (const line of content.split("\n")) {
    if (!line) paragraph = undefined;
    else if (blockLine.test(line)) return undefined;
    else if (paragraph) paragraph.push([{ text: line, style: "body" }]);
    else {
      paragraph = [[{ text: line, style: "body" }]];
      paragraphs.push(paragraph);
    }
  }
  return paragraphs;
}

class Unpredictable {
  constructor(readonly reason: ProseReason) {}
}
function fail(reason: ProseReason): never {
  throw new Unpredictable(reason);
}
function described<T>(describe: () => T): T | ProseReason {
  try {
    return describe();
  } catch (error) {
    if (error instanceof Unpredictable) return error.reason;
    throw error;
  }
}
const none: Inputs = {
  messages: [],
  inline: [],
  links: [],
  profiles: new Map(),
  channels: [],
  agents: [],
  resolveName: (_, fallback) => fallback,
};

/** Text, strong, emphasis and strikethrough only. */
const textual = (nodes: readonly PhrasingContent[]): boolean =>
  nodes.every(
    (node) =>
      node.type === "text" ||
      ((node.type === "strong" ||
        node.type === "emphasis" ||
        node.type === "delete") &&
        textual(node.children)),
  );
/** A parsed tree's paragraphs as MessageMarkdown renders them: text, strong,
 * emphasis, strikethrough (nested strong is bolder), line breaks, mentions,
 * profile links and link chips. A run marked `raw` (a link's text where the
 * destination is refused) is not split further by `prose`. */
function paragraphs(tree: Root, inputs: Inputs) {
  const result: (Run & { raw?: true })[][][] = [];
  for (const block of tree.children) {
    if (block.type !== "paragraph") fail("markdown");
    const segments: (Run & { raw?: true })[][] = [[]];
    const emit = (run: Run & { raw?: true }) => segments.at(-1)?.push(run);
    // renderProfile: a button when the reader can open the profile, an
    // agent's span otherwise, else the mention's text. A span is left to
    // measurement: WebKit narrows a line that breaks inside one by its
    // cloned padding.
    const mention = (text: string, target: string, style: Style) => {
      const key = profileKey(target);
      const agent =
        !!key &&
        (inputs.agents.some((entry) => entry.pubkey === key) ||
          !!inputs.profiles.get(key)?.isAgent);
      if (!inputs.canOpenLink?.(target)) {
        if (agent) fail("mentions");
        return false;
      }
      const label = key
        ? inputs.resolveName(key, text.slice(1))
        : text.slice(1);
      // A box's edges would collapse spaces the model keeps.
      if (label !== label.trim()) fail("mentions");
      emit({ text: label, style, box: agent ? "agent" : "person" });
      return true;
    };
    // A paragraph's children are at depth 2 of the tree.
    const walk = (
      nodes: readonly PhrasingContent[],
      bold: boolean,
      italic: boolean,
      depth = 2,
      raw = false,
    ): void => {
      // prepareMarkdown renders deeper content as plain text.
      if (depth > MAX_MARKDOWN_DEPTH) fail("plain-text");
      const style = bold
        ? italic
          ? "bold-italic"
          : "bold"
        : italic
          ? "italic"
          : "body";
      for (const node of nodes as readonly (
        | PhrasingContent
        | { type: "buzzInlineContent"; data?: { hProperties?: object } }
      )[]) {
        if (node.type === "break") segments.push([]);
        else if (node.type === "text")
          emit({ text: node.value, style, ...(raw ? { raw } : {}) });
        else if (node.type === "buzzInlineContent") {
          const props = (node.data?.hProperties ?? {}) as Record<
            string,
            unknown
          >;
          const text = String(props["data-inline-text"] ?? "");
          const target = props["data-profile-target"];
          if (props["data-literal-text"]) fail("entity");
          if (typeof target !== "string" || !mention(text, target, style))
            emit({ text, style });
        } else if (node.type === "strong") {
          if (bold) fail("nested-strong");
          walk(node.children, true, italic, depth + 1, raw);
        } else if (node.type === "emphasis")
          walk(node.children, bold, true, depth + 1, raw);
        else if (node.type === "delete")
          walk(node.children, bold, italic, depth + 1, raw);
        else if (node.type === "link" && !raw) {
          const href = transformUrl(node.url, "href", node as never);
          if (href && profileKey(href)) {
            // An openable profile link is a mention of its text.
            const label = node.children
              .map((child) =>
                child.type === "text" ? child.value : fail("mentions"),
              )
              .join("");
            if (
              !inputs.canOpenLink?.(href) ||
              !mention(label.startsWith("@") ? label : `@${label}`, href, style)
            )
              fail("mentions");
          } else if (href) {
            // A chip is one line of its label: a break in it is a second
            // line, and other content is not verified there.
            if (!textual(node.children)) fail("link");
            emit({ text: href, style, box: "chip" });
          }
          // A refused destination renders the link's text as it is.
          else walk(node.children, bold, italic, depth + 1, true);
        } else fail("markdown");
      }
    };
    walk(block.children, false, false);
    result.push(segments);
  }
  return result;
}
/** The paragraphs of parsed content without bound mentions or custom emoji
 * (MessageMarkdown's protected content is then the content itself). */
export const markdownParagraphs = (content: string, inputs = none) =>
  described<Prose>(() => paragraphs(parse(content), inputs));

/** Whether a row's prose reads more than the renderer registries: profiles,
 * channels, agents, profile access, names or link renderers. */
export const readsInputs = (row: ChannelMessage) =>
  !!(
    row.mentions.length ||
    row.mentionReferences?.length ||
    row.emoji?.length
  ) || /[#@[<]|:\/\/|www\./i.test(row.content);

/** Rows the model describes: paragraphs of text with strong, emphasis,
 * strikethrough, mentions, links, channel references and custom emoji.
 * Anything else a row renders besides its byline, or any other construct,
 * is a reason. Cheap row checks run first; content without Markdown syntax
 * skips the parse. */
export function prose(
  row: ChannelMessage,
  inputs: Inputs,
): Prose | ProseReason {
  if (row.membership) return "membership";
  if (row.diff) return "diff";
  if (row.attachments.length) return "attachments";
  if (row.reactions.length) return "reactions";
  if (row.replyCount > 0) return "thread";
  if (row.sentFromThread) return "sent-from-thread";
  // WorkflowByline and its avatar replace the byline the model sizes.
  if (row.workflowOwnerId) return "workflow";
  if (row.delivery && row.delivery !== "seen") return "delivery";
  const content = row.content;
  // prepareMarkdown renders these as pre-wrap plain text.
  if (content.length > MAX_MARKDOWN_LENGTH) return "plain-text";
  // Controls (tabs, carriage returns) and line separators lay out
  // differently; soft hyphens break unlike the browser.
  const characters =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: controls are rejected
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u2028\u2029]/;
  if (characters.test(content)) return "characters";
  if (content.includes("||")) return "spoiler";
  if (content.includes("&#")) return "entity";
  // Pasted wrapper links, which prepareMarkdown rewrites.
  if (content.includes("]\\(") || content.includes("]([")) return "link";
  if (parseMediaTimeReply(content)) return "time-reply";
  if (usesLargeEmojiPresentation(content, row.emoji)) return "large-emoji";
  if (
    inputs.messages.some((entry) => {
      try {
        return entry.matches(row);
      } catch {
        return false;
      }
    })
  )
    return "message-renderer";
  // renderText: links, then channel references (links too), then inline
  // renderers, each text node as React renders it.
  const chip = (run: Run): Run => {
    const renderer = resolveLink(run.text, inputs.links);
    return renderer && !bundled(renderer, LINKS) ? fail("link-renderer") : run;
  };
  const split = (run: Run & { raw?: true }): Run[] => {
    if (run.raw) return [{ text: run.text, style: run.style }];
    if (run.box) return [run.box === "chip" ? chip(run) : run];
    const { style } = run;
    const runs: Run[] = [];
    const inline = (text: string) => {
      let offset = 0;
      for (const match of inlineMatches(
        { text, message: row },
        inputs.inline,
      )) {
        if (!bundled(match.renderer, EMOJI)) fail("inline-renderer");
        runs.push({ text: text.slice(offset, match.start), style });
        runs.push({ text: "", style, box: "emoji" });
        offset = match.end;
      }
      runs.push({ text: text.slice(offset), style });
    };
    for (const part of messageLinkParts(run.text)) {
      if (part.url) {
        runs.push(chip({ text: part.url, style, box: "chip" }));
        continue;
      }
      let offset = 0;
      for (const reference of part.text.includes("#")
        ? messageReferences(
            part.text,
            [],
            inputs.profiles,
            inputs.channels,
            inputs.agents,
          )
        : []) {
        inline(part.text.slice(offset, reference.start));
        const url = `buzz://channel/${encodeURIComponent(reference.id)}`;
        runs.push(chip({ text: url, style, box: "chip" }));
        offset = reference.end;
      }
      inline(part.text.slice(offset));
    }
    return runs.filter(({ text, box }) => box || text);
  };
  return described(() => {
    let body: ReturnType<typeof paragraphs> | Prose | undefined;
    // Bound mentions and custom emoji: MessageMarkdown's protected tree.
    if (
      (!row.edited && (row.mentions.length || row.mentionReferences?.length)) ||
      row.emoji?.length
    ) {
      const prepared = prepareMarkdown(content);
      if (prepared.kind === "plain") return fail("plain-text");
      const protectedContent = protectInlineContent(
        row,
        inputs.profiles,
        prepared.literalRanges,
        inputs.agents,
        prepared.spoilerDelimiters,
      );
      const tree = parse(protectedContent.content);
      remarkInlineContent(protectedContent)(tree as never);
      body = paragraphs(tree, inputs);
    } else
      body = plainParagraphs(content) ?? paragraphs(parse(content), inputs);
    const result: Prose = body.map((segments) =>
      segments.map((runs) => {
        const split_ = runs.flatMap(split);
        // An empty line between breaks is rare; leave it to measurement.
        if (!split_.some(({ text, box }) => box || text.trim())) fail("empty");
        return split_;
      }),
    );
    return result.length ? result : fail("empty");
  });
}
