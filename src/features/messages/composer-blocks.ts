import {
  EditorState,
  AllSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import {
  wrapInList,
  liftListItem,
  splitListItemKeepMarks,
} from "prosemirror-schema-list";
import {
  lift,
  setBlockType,
  wrapIn,
  splitBlock,
  exitCode,
} from "prosemirror-commands";
import type { Command } from "prosemirror-state";
import {
  composerSchema as schema,
  projectComposerDocument,
} from "./composer-document";
import type { BlockFormat } from "./composer-dom";

export function activeBlockFormats(state: EditorState): BlockFormat[] {
  const selection =
    state.selection instanceof AllSelection
      ? TextSelection.between(
          Selection.atStart(state.doc).$from,
          Selection.atEnd(state.doc).$to,
        )
      : state.selection;
  const { $from, from, to } = selection;
  const active: BlockFormat[] = [];
  if ($from.parent.type === schema.nodes.code_block) {
    let all = true;
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isTextblock && node.type !== schema.nodes.code_block)
        all = false;
    });
    if (all) active.push("code_block");
  }
  let foundList = false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "bullet_list" || name === "ordered_list") {
      if (foundList) continue;
      foundList = true;
    }
    if (
      ["blockquote", "bullet_list", "ordered_list"].includes(name) &&
      to <= $from.end(depth) &&
      !active.includes(name as BlockFormat)
    )
      active.push(name as BlockFormat);
  }
  return active;
}

/** Block toggles isolate the selected prose, or the caret's newline-delimited
 * line. Splits and the format itself remain a single history transaction. */
function isolate(tr: Transaction) {
  const selection = tr.selection;
  let { from, to } = selection;
  const backward = selection.anchor > selection.head;
  if (
    selection.empty &&
    selection.$from.parent.type === schema.nodes.paragraph
  ) {
    const source = projectComposerDocument(tr.doc);
    const text = source.draft.text,
      caret = source.source(from);
    const block = source.blocks.find(
      (block) => from >= block.from && from <= block.to,
    );
    if (!block) return;
    const start = Math.max(block.start, text.lastIndexOf("\n", caret - 1) + 1);
    const newline = text.indexOf("\n", caret);
    from = source.position(start);
    to =
      newline < 0 ? block.to : Math.min(block.to, source.position(newline, -1));
  }
  // Raw newlines are existing prose, not extra empty paragraphs around a block.
  const split = (position: number, before: boolean) => {
    const $pos = tr.doc.resolve(position);
    if ($pos.parent.type !== schema.nodes.paragraph) return;
    if (
      (!before && $pos.parentOffset === $pos.parent.content.size) ||
      (before && $pos.parentOffset === 0)
    )
      return;
    const adjacent = before ? $pos.nodeBefore : $pos.nodeAfter;
    if (
      adjacent?.isText &&
      (before
        ? adjacent.textContent.endsWith("\n")
        : adjacent.textContent.startsWith("\n"))
    ) {
      const start = before ? position - 1 : position;
      tr.delete(start, start + 1);
      if (before) position--;
    } else if (adjacent?.type === schema.nodes.hard_break) {
      const start = before ? position - 1 : position;
      tr.delete(start, start + 1);
      if (before) position--;
    }
    tr.split(position);
  };
  let caret = selection.from;
  const isolateEdge = (position: number, before: boolean) => {
    const steps = tr.steps.length;
    split(position, before);
    const mapping = tr.mapping.slice(steps),
      bias = before ? 1 : -1;
    from = mapping.map(from, bias);
    to = mapping.map(to, bias);
    caret = mapping.map(caret, bias);
  };
  isolateEdge(to, false);
  isolateEdge(from, true);
  if (selection.empty) tr.setSelection(TextSelection.create(tr.doc, caret));
  else
    tr.setSelection(
      TextSelection.create(tr.doc, backward ? to : from, backward ? from : to),
    );
}

/** Use native ProseMirror block commands, composing their steps into the same
 * transaction as token expansion/selection isolation. No second history owner. */
function apply(tr: Transaction, command: Command) {
  const state = EditorState.create({
    doc: tr.doc,
    selection: tr.selection,
    storedMarks: tr.storedMarks,
  });
  return command(state, (next) => {
    for (const step of next.steps) tr.step(step);
    tr.setSelection(next.selection.getBookmark().resolve(tr.doc));
    if (next.storedMarksSet) tr.setStoredMarks(next.storedMarks);
  });
}

export function toggleComposerBlock(
  state: EditorState,
  format: BlockFormat,
): Transaction | undefined {
  const tr = state.tr;
  const formats = activeBlockFormats(state);
  const active = formats.includes(format);
  const list = format === "bullet_list" || format === "ordered_list";
  const inList = formats.some(
    (name) => name === "bullet_list" || name === "ordered_list",
  );
  if (list && inList) {
    if (active)
      return apply(tr, liftListItem(schema.nodes.list_item)) ? tr : undefined;
    // Switch the selected list owner in place, never lift into an ancestor
    // merely because that ancestor already uses the requested marker style.
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if (["bullet_list", "ordered_list"].includes($from.node(depth).type.name))
        return tr.setNodeMarkup($from.before(depth), schema.nodes[format]);
    }
  }
  // The first child of a list item must stay a paragraph. Lift before replacing
  // it with a code/quote block, rather than leaving the toolbar silently inert.
  if (
    !list &&
    inList &&
    !active &&
    !apply(tr, liftListItem(schema.nodes.list_item))
  )
    return;
  if (format === "blockquote" && active)
    return apply(tr, lift) ? tr : undefined;
  if (format === "code_block" && active)
    return apply(tr, setBlockType(schema.nodes.paragraph))
      ? tr.setStoredMarks([])
      : undefined;
  isolate(tr);
  if (list) {
    // Prose keeps authored newlines inside paragraphs. A list command turns
    // those selected lines into separate items without changing source text.
    apply(tr, setBlockType(schema.nodes.paragraph));
    const breaks: number[] = [];
    tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
      if (node.type !== schema.nodes.paragraph) return;
      node.forEach((child, offset) => {
        if (child.isText)
          for (let i = 0; i < child.textContent.length; i++) {
            if (child.textContent[i] === "\n")
              breaks.push(pos + 1 + offset + i);
          }
        else if (child.type === schema.nodes.hard_break)
          breaks.push(pos + 1 + offset);
      });
      return false;
    });
    for (const pos of breaks.reverse()) {
      tr.delete(pos, pos + 1);
      tr.split(pos);
    }
    return apply(tr, wrapInList(schema.nodes[format])) ? tr : undefined;
  }
  if (format === "blockquote")
    return apply(tr, wrapIn(schema.nodes.blockquote)) ? tr : undefined;
  // Expand all leaves in the affected textblocks, including a collapsed caret's
  // line, before applying the text-only schema. Explicit recipient intent stays.
  const leaves: { pos: number; node: import("prosemirror-model").Node }[] = [];
  tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (block, pos) => {
    if (!block.isTextblock) return;
    block.forEach((node, offset) => {
      if (!node.isText) leaves.push({ pos: pos + 1 + offset, node });
    });
    return false;
  });
  for (const { pos, node } of leaves.reverse()) {
    const text =
      node.type === schema.nodes.hard_break
        ? "\n"
        : (node.attrs.source as string);
    const marks = node.attrs.recipient
      ? [schema.marks.recipient.create(node.attrs.recipient)]
      : [];
    tr.replaceWith(pos, pos + node.nodeSize, schema.text(text, marks));
  }
  if (!apply(tr, setBlockType(schema.nodes.code_block))) return;
  // Multiple selected paragraphs become one code block, not separate fences.
  const joins: number[] = [];
  tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
    if (
      node.type === schema.nodes.code_block &&
      tr.doc.resolve(pos).nodeBefore?.type === node.type &&
      pos > tr.selection.from
    )
      joins.push(pos);
  });
  for (const pos of joins.reverse()) {
    tr.insertText("\n", pos - 1);
    tr.join(pos + 1);
  }
  return tr.setStoredMarks([]);
}

/** Shift+Enter continues the block; an empty last line exits it. Plain Enter
 * remains the host's existing send/completion policy. */
export function composerBlockLineBreak(
  state: EditorState,
): Transaction | undefined {
  const { $from, empty } = state.selection;
  const tr = state.tr;
  if ($from.parent.type === schema.nodes.code_block) {
    if (
      empty &&
      $from.parentOffset === $from.parent.content.size &&
      $from.parent.textContent.endsWith("\n")
    ) {
      tr.delete($from.pos - 1, $from.pos);
      return apply(tr, exitCode) ? tr.setStoredMarks([]) : undefined;
    }
    return tr.insertText("\n");
  }
  const formats = activeBlockFormats(state);
  if (
    formats.some((name) => name === "bullet_list" || name === "ordered_list")
  ) {
    return apply(tr, splitListItemKeepMarks(schema.nodes.list_item)) ||
      apply(tr, liftListItem(schema.nodes.list_item))
      ? tr
      : undefined;
  }
  if (formats.includes("blockquote")) {
    return apply(tr, empty && !$from.parent.content.size ? lift : splitBlock)
      ? tr
      : undefined;
  }
}
