import type { ComposerFormat } from "./ComposerFormattingBar";
import { replaceMentionDraft, type MentionDraft } from "./mention-draft";

export type FormattingEdit = Readonly<{
  draft: MentionDraft;
  selectionStart: number;
  selectionEnd: number;
}>;

const markers: Partial<Record<ComposerFormat, string>> = {
  bold: "**",
  italic: "*",
  strike: "~~",
};

type InlineWrapper = Readonly<{
  before: string;
  after: string;
  legacyMarker?: string;
}>;

function codeWrapper(content: string): InlineWrapper {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), ({ 0: run }) => run.length),
  );
  const fence = "`".repeat(longestRun + 1);
  const padding = content.includes("`") || /^ | $/.test(content) ? " " : "";
  return { before: fence + padding, after: padding + fence };
}

function inlineEdit(
  draft: MentionDraft,
  start: number,
  end: number,
  wrapper: InlineWrapper,
): FormattingEdit {
  const selected = draft.text.slice(start, end);
  const leading = selected.match(/^\s*/)?.[0].length ?? 0;
  const trailing = selected.match(/\s*$/)?.[0].length ?? 0;
  const contentStart = start + leading;
  const contentEnd = Math.max(contentStart, end - trailing);
  const wrappedBefore = draft.text.slice(
    contentStart - wrapper.before.length,
    contentStart,
  );
  const wrappedAfter = draft.text.slice(
    contentEnd,
    contentEnd + wrapper.after.length,
  );
  const asteriskRunBefore =
    wrapper.before === "*"
      ? (draft.text.slice(0, contentStart).match(/\*+$/)?.[0].length ?? 0)
      : 0;
  const asteriskRunAfter =
    wrapper.after === "*"
      ? (draft.text.slice(contentEnd).match(/^\*+/)?.[0].length ?? 0)
      : 0;
  const wrapped =
    wrapper.before === "*"
      ? asteriskRunBefore % 2 === 1 && asteriskRunAfter % 2 === 1
      : wrappedBefore === wrapper.before && wrappedAfter === wrapper.after;
  const legacyWrapped =
    wrapper.legacyMarker &&
    draft.text.slice(
      contentStart - wrapper.legacyMarker.length,
      contentStart,
    ) === wrapper.legacyMarker &&
    draft.text.slice(contentEnd, contentEnd + wrapper.legacyMarker.length) ===
      wrapper.legacyMarker;
  const legacyMarker = legacyWrapped ? wrapper.legacyMarker : undefined;
  const before = legacyMarker ?? wrapper.before;
  const after = legacyMarker ?? wrapper.after;
  if (wrapped || legacyWrapped) {
    let next = replaceMentionDraft(
      draft,
      contentEnd,
      contentEnd + after.length,
      "",
    );
    next = replaceMentionDraft(
      next,
      contentStart - before.length,
      contentStart,
      "",
    );
    return {
      draft: next,
      selectionStart: contentStart - before.length,
      selectionEnd: contentEnd - before.length,
    };
  }
  let next = replaceMentionDraft(draft, contentEnd, contentEnd, wrapper.after);
  next = replaceMentionDraft(next, contentStart, contentStart, wrapper.before);
  return {
    draft: next,
    selectionStart: contentStart + wrapper.before.length,
    selectionEnd: contentEnd + wrapper.before.length,
  };
}

/** Applies Markdown through known insertions so untouched notification intent survives. */
export function formatComposerDraft(
  draft: MentionDraft,
  start: number,
  end: number,
  format: Exclude<ComposerFormat, "link">,
): FormattingEdit {
  const selected = draft.text.slice(start, end);
  if (format === "code")
    return inlineEdit(draft, start, end, codeWrapper(selected.trim()));
  const marker = markers[format];
  if (marker)
    return inlineEdit(draft, start, end, {
      before: marker,
      after: marker,
      ...(format === "italic" ? { legacyMarker: "_" } : {}),
    });
  const lineStart = draft.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEnd = draft.text.indexOf("\n", end);
  const boundary = lineEnd < 0 ? draft.text.length : lineEnd;
  const prefix = format === "quote" ? "> " : format === "bullet" ? "- " : "1. ";
  const starts = [lineStart];
  for (
    let index = draft.text.indexOf("\n", lineStart);
    index >= 0 && index < boundary;
    index = draft.text.indexOf("\n", index + 1)
  )
    starts.push(index + 1);
  let next = draft;
  for (const position of [...starts].reverse())
    next = replaceMentionDraft(next, position, position, prefix);
  return {
    draft: next,
    selectionStart: start + prefix.length,
    selectionEnd: end + prefix.length * starts.length,
  };
}

export function markdownLink(label: string, url: string) {
  const escapePunctuation = (value: string) =>
    value.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
  return `[${escapePunctuation(label)}](${escapePunctuation(url)})`;
}
