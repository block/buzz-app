import type { Context } from "@deepseek-ai/cordis";
import {
  activeMessageList,
  focusTarget,
  messageListElements,
  messageListOf,
  selectedMessage,
  selectMessage,
  selectNewestMessage,
} from "./message-selection";

const ROW = "[data-message-id]";

/** A message list on screen: a conversation, an inline thread, a thread tab. */
export type MessageListHandle = Readonly<{
  element: HTMLElement;
  /** The conversation's newest message id, rendered or not. */
  newest(): string | undefined;
  /** Whether the list holds this message, rendered or not. */
  has(id: string): boolean;
  /** Keep a message rendered while it is scrolled away, until released. */
  keepMounted(id: string): () => void;
}>;

/**
 * Messages and the keyboard selection, for plugins. A selected message is a
 * focused row: its message box (`focusTarget`) has focus. Rows are
 * `[data-message-id]` elements; everything inside a row is plain page content.
 */
export type Messages = Readonly<{
  /** Every message list on screen. */
  lists(): readonly HTMLElement[];
  /** The innermost list holding `node`. */
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

export const messages: Messages = Object.freeze({
  lists: messageListElements,
  listOf(node: Node) {
    const owner = messageListOf(node);
    if (!owner) return undefined;
    const { element, list } = owner;
    return Object.freeze({
      element,
      newest: () => list.newest(),
      has: (id: string) => !!list.row(id),
      keepMounted: (id: string) => list.keepMounted?.(id) ?? (() => {}),
    });
  },
  active: activeMessageList,
  focusTarget,
  selected() {
    const selected = selectedMessage();
    const id = selected?.element.dataset.messageId;
    const list = selected && messageListOf(selected.element)?.element;
    return selected && id && list
      ? { row: selected.element, id, list }
      : undefined;
  },
  select(row: HTMLElement) {
    if (row.isConnected) selectMessage(row);
  },
  selectNewest: (list: HTMLElement) => selectNewestMessage(list),
  openActions(element: HTMLElement) {
    const event = new KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  },
  hasThread: (row: HTMLElement) => !!threadSummary(row),
  openThread(row: HTMLElement) {
    const summary = threadSummary(row);
    summary?.click();
    return !!summary;
  },
});

export function provideMessages(ctx: Context) {
  ctx.provide("messages", messages);
}
