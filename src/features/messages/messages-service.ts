import { type Context, Service } from "@deepseek-ai/cordis";
import {
  activeMessageList,
  focusTarget,
  messageListElements,
  messageListOf,
  selectedMessage,
  selectMessage,
  selectNewestMessage,
} from "./message-selection";
import type { ComposerInputElement } from "./composer-dom";
import { setComposerStatus } from "./composer-status";

const ROW = "[data-message-id]";

/** A message list on screen: a conversation, an inline thread, a thread tab. */
export type MessageListHandle = Readonly<{
  element: HTMLElement;
  /** The conversation's newest message id, rendered or not. */
  newest(): string | undefined;
  /** Whether the list holds this message, rendered or not. */
  has(id: string): boolean;
  /** Keep a message rendered while it is scrolled away, until released or
   * the plugin stops. */
  keepMounted(id: string): () => void;
  /** The list's message box editor; pass it to `composerOf`. */
  composer(): HTMLElement | undefined;
}>;

/** A conversation's message box, for plugins that edit it from the keyboard.
 * Offsets count characters of `value`, the draft as plain text. */
export type MessageBox = Readonly<{
  /** The editor element: focus it, or check what it contains. */
  element: HTMLElement;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly selectionDirection: "forward" | "backward" | "none";
  /** Ranges that select and delete only as a whole, such as mentions. */
  readonly atoms: readonly Readonly<{ start: number; end: number }>[];
  /** How many steps `undo(false)` can take back now. */
  readonly undoDepth: number;
  setSelectionRange(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void;
  /** Replace `range`, or the selection, with `text` in one undo step. */
  insertText(text: string, range?: { start: number; end: number }): boolean;
  /** Undo, or redo when `redo` is true. */
  undo(redo: boolean): void;
  /** A short status beside Send, such as a key mode; undefined clears it, and
   * so does the plugin stopping. */
  setStatus(status: string | undefined): void;
}>;

/**
 * Messages and the keyboard selection, for plugins. A selected message is a
 * focused row: its message box (`focusTarget`) has focus. Rows are
 * `[data-message-id]` elements; everything inside a row is plain page content.
 */
export type Messages = Readonly<{
  /** Every message list on screen. */
  lists(): readonly HTMLElement[];
  /** The innermost list holding `node`. The same list gives the same handle
   * until it re-registers, as when its conversation changes. */
  listOf(node: Node): MessageListHandle | undefined;
  /** The focused pane's list, else the first visible one. */
  active(): HTMLElement | undefined;
  /** A row's message box: the element that takes focus when it's selected. */
  focusTarget(row: HTMLElement): HTMLElement;
  selected():
    | Readonly<{ row: HTMLElement; id: string; list: HTMLElement }>
    | undefined;
  select(row: HTMLElement): void;
  /** False when the newest message isn't rendered, or there is none. */
  selectNewest(list: HTMLElement): boolean;
  /** Open the element's own action menu, as the Menu key does: a message's,
   * or a part's such as its author. True when one opened. */
  openActions(element: HTMLElement): boolean;
  hasThread(row: HTMLElement): boolean;
  /** Open the row's thread. False when it has none. */
  openThread(row: HTMLElement): boolean;
  /** The message box whose editor is `element`, or holds it. */
  composerOf(element: Element | null): MessageBox | undefined;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    messages: Messages;
  }
}

const threadSummary = (row: HTMLElement) =>
  [...row.querySelectorAll<HTMLElement>("button[data-thread-summary]")].find(
    (summary) => summary.closest(ROW) === row,
  );

function editorOf(element: Element | null) {
  const editor = element?.closest<HTMLElement>('[role="textbox"]');
  return editor?.closest("[data-composer-surface]") &&
    typeof (editor as Partial<ComposerInputElement>).insertText === "function"
    ? (editor as ComposerInputElement)
    : undefined;
}

/** One plugin's handles, so each carries that plugin's cleanup and stays the
 * same object across calls. */
type Owned = {
  boxes: WeakMap<ComposerInputElement, MessageBox>;
  lists: WeakMap<object, MessageListHandle>;
};

function messageBox(ctx: Context, editor: ComposerInputElement): MessageBox {
  /** Removes the plugin's cleanup for its label, while one is shown. */
  let clearOnStop: (() => void) | undefined;
  return Object.freeze({
    element: editor,
    get value() {
      return editor.value;
    },
    get selectionStart() {
      return editor.selectionStart;
    },
    get selectionEnd() {
      return editor.selectionEnd;
    },
    get selectionDirection() {
      return editor.selectionDirection;
    },
    get atoms() {
      return editor.atoms;
    },
    get undoDepth() {
      return editor.undoDepth;
    },
    setSelectionRange: (start, end, direction) =>
      editor.setSelectionRange(start, end, direction),
    insertText: (text, range) =>
      editor.insertText(text, undefined, range) !== false,
    undo: (redo) => editor.undo(redo),
    setStatus(status) {
      setComposerStatus(editor, status);
      if (status && !clearOnStop) {
        const remove = ctx.effect(
          () => () => setComposerStatus(editor, undefined),
          "messages.setStatus",
        );
        clearOnStop = () => void remove();
      } else if (!status && clearOnStop) {
        const remove = clearOnStop;
        clearOnStop = undefined;
        remove();
      }
    },
  });
}

/** Methods see the calling plugin as `this.ctx`, so what a plugin holds (a
 * kept row, a label) is let go when it stops, as Cordis does for the rest. */
export class MessagesService extends Service implements Messages {
  /** Keyed by the plugin's fiber: `this.ctx` is a new object on each call. */
  private readonly owned = new WeakMap<object, Owned>();
  constructor(ctx: Context) {
    super(ctx, "messages");
  }
  private ownedBy(ctx: Context) {
    let owned = this.owned.get(ctx.fiber);
    if (!owned) {
      owned = { boxes: new WeakMap(), lists: new WeakMap() };
      this.owned.set(ctx.fiber, owned);
    }
    return owned;
  }
  lists() {
    return messageListElements();
  }
  listOf(node: Node) {
    const owner = messageListOf(node);
    if (!owner) return undefined;
    const { element, list } = owner;
    const ctx = this.ctx;
    const handles = this.ownedBy(ctx).lists;
    const known = handles.get(list);
    if (known?.element === element) return known;
    const handle: MessageListHandle = Object.freeze({
      element,
      newest: () => list.newest(),
      has: (id: string) => !!list.row(id),
      keepMounted(id: string) {
        const release = ctx.effect(
          () => list.keepMounted?.(id) ?? (() => {}),
          "messages.keepMounted",
        );
        return () => void release();
      },
      composer: () => list.composer() ?? undefined,
    });
    handles.set(list, handle);
    return handle;
  }
  active() {
    return activeMessageList();
  }
  focusTarget(row: HTMLElement) {
    return focusTarget(row);
  }
  selected() {
    const selected = selectedMessage();
    const id = selected?.element.dataset.messageId;
    const list = selected && messageListOf(selected.element)?.element;
    return selected && id && list
      ? { row: selected.element, id, list }
      : undefined;
  }
  select(row: HTMLElement) {
    if (row.isConnected) selectMessage(row);
  }
  selectNewest(list: HTMLElement) {
    return selectNewestMessage(list);
  }
  openActions(element: HTMLElement) {
    const event = new KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }
  hasThread(row: HTMLElement) {
    return !!threadSummary(row);
  }
  openThread(row: HTMLElement) {
    const summary = threadSummary(row);
    summary?.click();
    return !!summary;
  }
  composerOf(element: Element | null) {
    const editor = editorOf(element);
    if (!editor) return undefined;
    const boxes = this.ownedBy(this.ctx).boxes;
    let box = boxes.get(editor);
    if (!box) {
      box = messageBox(this.ctx, editor);
      boxes.set(editor, box);
    }
    return box;
  }
}
