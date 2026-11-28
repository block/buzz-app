/*
 * Vim's modes in the message box. The message box's own text, selection,
 * edits and undo (`MessageBox`) carry them out; `editing.ts` decides.
 * Focus entering the message box starts in insert mode, where every key is
 * the editor's. Escape there is normal mode, with a block cursor, where no
 * key types; Escape in normal mode leaves, as before. The mode shows beside
 * Send. Each Vim command, including an insert from `o` or `c` to Escape, is
 * one undo step, however many steps it took in the editor.
 */
import type { MessageBox } from "../../plugins/author";
import { host } from "./host";
import {
  insert,
  type Mode,
  normal,
  press,
  REDO,
  type Register,
  selection,
  settle,
  type Vim,
  withCharacters,
} from "./editing";
import { blockCursor, scrollOff } from "./block-cursor";
import { WHICH_KEY } from "./dom";

const STATUS: Record<Mode, string> = {
  normal: "-- NORMAL --",
  insert: "-- INSERT --",
  visual: "-- VISUAL --",
  "visual-line": "-- VISUAL LINE --",
};
const SPOKEN: Record<Mode, string> = {
  normal: "Normal mode",
  insert: "Insert mode",
  visual: "Visual mode",
  "visual-line": "Visual line mode",
};
/** Named keys as Vim reads them in normal and visual modes; Enter does
 * nothing there. Tab and the rest keep their usual meaning. */
const NAMED: Record<string, string> = {
  ArrowLeft: "h",
  ArrowRight: "l",
  ArrowUp: "k",
  ArrowDown: "j",
  Backspace: "h",
  Delete: "x",
  Home: "0",
  End: "$",
  Enter: "",
};

/** The message box whose editor is `element`. */
export const composerEditor = (element: Element | null | undefined) =>
  host.messages.composerOf(element ?? null);

const buffer = (input: MessageBox) =>
  withCharacters({ text: input.value, atoms: input.atoms });
const head = (input: MessageBox) =>
  input.selectionDirection === "backward"
    ? input.selectionStart
    : input.selectionEnd;
const visual = (mode: Mode) => mode === "visual" || mode === "visual-line";

/** The editor's undo steps each Vim command took, newest last; `depth` is
 * the editor's undo depth when they were last counted. */
type Steps = { done: number[]; undone: number[]; depth: number };
const stepsOf = new WeakMap<MessageBox, Steps>();
/** Count the editor's steps since the last count as one command. */
function count(input: MessageBox) {
  const depth = input.undoDepth;
  const steps = stepsOf.get(input);
  if (!steps) stepsOf.set(input, { done: [], undone: [], depth });
  else if (depth < steps.depth) {
    // Undone outside Vim, or the history was cut: start counting again.
    // ponytail: past the editor's 100-step history, a new step can leave
    // the depth unchanged and go uncounted; count events if that bites.
    stepsOf.set(input, { done: [], undone: [], depth });
  } else if (depth > steps.depth) {
    steps.done.push(depth - steps.depth);
    steps.undone = [];
    steps.depth = depth;
  }
  return stepsOf.get(input) as Steps;
}

export function composerModes({
  apple,
  announce,
  leader,
}: {
  apple: boolean;
  announce(text: string): void;
  /** Space in normal mode starts the leader keys. */
  leader(): void;
}) {
  /** The focused message box and its mode; one at a time, as focus is. */
  let active: { input: MessageBox; vim: Vim } | undefined;
  /** The selection a visual mode last showed, to notice a click moving it. */
  let shown: { start: number; end: number } | undefined;
  let register: Register | undefined;
  /** The block cursor, in normal mode. */
  let block: ReturnType<typeof blockCursor> | undefined;

  const set = (input: MessageBox, vim: Vim) => {
    const before = active?.input === input ? active.vim.mode : undefined;
    if (before === undefined) count(input);
    active = { input, vim };
    input.setStatus(STATUS[vim.mode]);
    if (before && before !== vim.mode) announce(SPOKEN[vim.mode]);
  };
  const show = (input: MessageBox, vim: Vim) => {
    if (vim.mode !== "normal") {
      block?.stop();
      block = undefined;
    }
    if (!visual(vim.mode)) {
      shown = undefined;
      input.setSelectionRange(vim.cursor, vim.cursor);
      if (vim.mode === "normal") {
        scrollOff(input.element);
        block ??= blockCursor(input.element);
        block.draw();
      }
      return;
    }
    const range = selection(vim, buffer(input));
    input.setSelectionRange(
      range.start,
      range.end,
      vim.cursor < vim.anchor ? "backward" : "forward",
    );
    shown = { start: input.selectionStart, end: input.selectionEnd };
    scrollOff(input.element);
  };
  const reset = () => {
    block?.stop();
    block = undefined;
    if (active) active.input.setStatus(undefined);
    active = undefined;
    shown = undefined;
  };

  const keydown = (event: KeyboardEvent) => {
    const input = composerEditor(document.activeElement);
    if (
      !input ||
      active?.input !== input ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229
    )
      return;
    const plain =
      !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const escaping =
      (event.key === "Escape" && plain) ||
      (apple &&
        event.key === "[" &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey);
    let vim = active.vim;
    if (vim.mode === "insert") {
      // A suggestion list has the first Escape.
      if (!escaping || input.element.hasAttribute("aria-controls")) return;
      event.preventDefault();
      event.stopPropagation();
      run(input, { ...vim, cursor: head(input) }, "Escape");
      return;
    }
    const key = escaping
      ? "Escape"
      : event.metaKey || event.altKey
        ? undefined
        : event.ctrlKey
          ? event.key === "r" && !event.shiftKey
            ? REDO
            : undefined
          : event.key.length === 1
            ? event.key
            : NAMED[event.key];
    if (key === undefined) return;
    // A click or the editor may have moved the caret since the last key.
    const caret = head(input);
    if (
      visual(vim.mode) &&
      (input.selectionStart !== shown?.start ||
        input.selectionEnd !== shown?.end)
    )
      vim = normal(caret);
    if (vim.mode === "normal") vim = settle(vim, buffer(input), caret);
    // Escape with nothing pending leaves the message box, as before.
    if (key === "Escape" && vim.mode === "normal" && !vim.typed.length) {
      active = { input, vim };
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (key === " " && vim.mode === "normal" && !vim.typed.length) {
      active = { input, vim };
      leader();
      return;
    }
    if (key) run(input, vim, key);
  };

  function run(input: MessageBox, vim: Vim, key: string) {
    const result = press(vim, buffer(input), key, register);
    if (result.register) register = result.register;
    // What came before, such as an insert ending with this Escape, is one
    // command; this key's edits are the next.
    const steps = count(input);
    // From the end, so each range is still where the engine saw it.
    for (const { start, end, text } of [...(result.edits ?? [])].sort(
      (a, b) => b.start - a.start,
    ))
      input.insertText(text, { start, end });
    let next = result.vim;
    // An insert after an edit, as `o` and `c` start, joins it: Escape counts.
    if (next.mode !== "insert") count(input);
    if (result.history) {
      const { redo, times } = result.history;
      for (let time = 0; time < times; time++) {
        const editorSteps = (redo ? steps.undone : steps.done).pop() ?? 1;
        for (let step = 0; step < editorSteps; step++) input.undo(redo);
        (redo ? steps.done : steps.undone).push(editorSteps);
      }
      steps.depth = input.undoDepth;
      next = { ...next, cursor: input.selectionStart };
    }
    // An edit the editor refused leaves the cursor where the text allows.
    next = settle(next, buffer(input));
    set(input, next);
    show(input, next);
  }

  /** Tab in insert mode types a tab, as in Vim, once the editor has passed
   * on it: a completion or a list's indent still takes it first. */
  const tab = (event: KeyboardEvent) => {
    const input = composerEditor(document.activeElement);
    if (
      event.key !== "Tab" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !input ||
      active?.input !== input ||
      active.vim.mode !== "insert"
    )
      return;
    event.preventDefault();
    input.insertText("\t");
  };

  /** Pasting or cutting would type too, so normal and visual modes refuse. */
  const clipboard = (event: ClipboardEvent) => {
    if (
      active &&
      active.vim.mode !== "insert" &&
      composerEditor(document.activeElement) === active.input
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  /** Focus entering a message box types; the leader's menu keeps the mode. */
  const focusin = (event: FocusEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(`[${WHICH_KEY}]`)) return;
    const input = composerEditor(target);
    if (active && active.input !== input) reset();
    if (input && !active) set(input, insert(head(input)));
  };
  /** Focus leaving for nothing, such as a removed element, ends the mode. */
  const focusout = () =>
    requestAnimationFrame(() => {
      const focus = document.activeElement;
      if (
        active &&
        focus !== active.input.element &&
        !focus?.closest(`[${WHICH_KEY}]`)
      )
        reset();
    });

  addEventListener("keydown", keydown, true);
  addEventListener("keydown", tab);
  addEventListener("paste", clipboard, true);
  addEventListener("cut", clipboard, true);
  document.addEventListener("focusin", focusin);
  document.addEventListener("focusout", focusout);
  const input = composerEditor(document.activeElement);
  if (input) set(input, insert(head(input)));

  return {
    /** `<leader>i`: type in the focused message box. */
    insert() {
      const input = composerEditor(document.activeElement);
      if (!input) return;
      const vim = insert(head(input));
      count(input);
      set(input, vim);
      show(input, vim);
    },
    stop() {
      removeEventListener("keydown", keydown, true);
      removeEventListener("keydown", tab);
      removeEventListener("paste", clipboard, true);
      removeEventListener("cut", clipboard, true);
      document.removeEventListener("focusin", focusin);
      document.removeEventListener("focusout", focusout);
      reset();
    },
  };
}
