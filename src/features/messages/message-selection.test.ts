// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import type { ChannelMessage } from "../relay/contracts";
import {
  activeMessageList,
  moveMessageSelection,
  reactionTrigger,
  registerMessageList,
  selectedMessage,
  selectNewestMessage,
  type MessageList,
} from "./message-selection";
import { Context } from "@deepseek-ai/cordis";
import { MessagesService } from "./messages-service";

const messages = new MessagesService(new Context());
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

const message = (id: string) => ({ id }) as ChannelMessage;

function fixture(ids = ["one", "two", "three"], newest = ids.at(-1)) {
  const list = document.createElement("section");
  list.innerHTML = ids
    .map(
      (id) =>
        `<div data-message-id="${id}"><div data-layout="timeline"><span>${id}</span>` +
        `<div role="group"><span data-reaction-tool><button aria-haspopup="dialog">React</button></span></div>` +
        "</div></div>",
    )
    .join("");
  const composer = document.createElement("textarea");
  document.body.append(list, composer);
  const controller: MessageList = {
    row: (id) => (ids.includes(id) ? message(id) : undefined),
    newest: () => newest,
    canEdit: (row) => row.id !== "one",
    edit: vi.fn(),
    canDelete: () => false,
    remove: vi.fn(),
    canMarkUnread: () => false,
    markUnread: vi.fn(),
    composer: () => composer,
    canQuote: () => false,
    quote: vi.fn(),
  };
  cleanups.push(registerMessageList(list, controller));
  const box = (id: string) =>
    list.querySelector<HTMLElement>(
      `[data-message-id="${id}"] > [data-layout]`,
    );
  return { list, composer, controller, box };
}

function key(
  list: HTMLElement,
  name: string,
  modifiers = {},
  target: Element | null = document.activeElement,
) {
  const event = {
    key: name,
    target,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
    defaultPrevented: false,
    currentTarget: list,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  moveMessageSelection(event as unknown as KeyboardEvent<HTMLElement>);
  return event.defaultPrevented;
}

it("selects the newest message's box and reports it as selected", () => {
  const { list, box, controller } = fixture();
  expect(selectNewestMessage(list)).toBe(true);
  expect(document.activeElement).toBe(box("three"));
  expect(selectedMessage()).toMatchObject({
    row: { id: "three" },
    list: controller,
  });
  expect(selectNewestMessage(document.createElement("section"))).toBe(false);
});

it("selects the newest message by id when tree order puts an older sibling last", () => {
  // An expanded branch renders its newer reply above a later, older sibling.
  const { list, box } = fixture(
    ["root", "newer-reply", "older-sibling"],
    "newer-reply",
  );
  expect(selectNewestMessage(list)).toBe(true);
  expect(document.activeElement).toBe(box("newer-reply"));
});

it("treats only the message itself as selected, not a control inside it", () => {
  const { list } = fixture();
  selectNewestMessage(list);
  list.querySelector<HTMLButtonElement>("button")?.focus();
  expect(selectedMessage()).toBeUndefined();
});

it("moves with Up and Down and returns to the composer past the newest", () => {
  const { list, box, composer } = fixture();
  selectNewestMessage(list);
  expect(key(list, "ArrowUp")).toBe(true);
  expect(document.activeElement).toBe(box("two"));
  expect(key(list, "ArrowUp")).toBe(true);
  expect(document.activeElement).toBe(box("one"));
  // The oldest rendered row leaves Up native so older history can load.
  expect(key(list, "ArrowUp")).toBe(false);
  expect(document.activeElement).toBe(box("one"));
  expect(key(list, "ArrowDown")).toBe(true);
  expect(key(list, "ArrowDown")).toBe(true);
  expect(document.activeElement).toBe(box("three"));
  expect(key(list, "ArrowDown")).toBe(true);
  expect(document.activeElement).toBe(composer);
});

it("returns to the composer on Escape and ignores modified or unselected keys", () => {
  const { list, box, composer } = fixture();
  selectNewestMessage(list);
  expect(key(list, "ArrowUp", { altKey: true })).toBe(false);
  expect(key(list, "ArrowUp", { shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(box("three"));
  expect(key(list, "Escape")).toBe(true);
  expect(document.activeElement).toBe(composer);
  expect(key(list, "ArrowUp")).toBe(false);
});

it("ignores a key that reached the list from elsewhere after focus returned", () => {
  // A menu in the list's tree returns focus to the message while its Escape
  // is still bubbling; that Escape closed the menu and must not move on.
  const { list, box } = fixture();
  selectNewestMessage(list);
  const menu = document.createElement("div");
  list.append(menu);
  expect(key(list, "Escape", {}, menu)).toBe(false);
  expect(document.activeElement).toBe(box("three"));
  // Opening, a menu owns the keys before focus moves into it.
  box("three")?.setAttribute("data-menu-origin", "");
  expect(key(list, "Escape")).toBe(false);
  expect(key(list, "ArrowUp")).toBe(false);
  expect(document.activeElement).toBe(box("three"));
});

it("finds the selected message's reaction trigger, preferring its action bar", () => {
  const { list, box } = fixture(["one"]);
  const row = list.querySelector<HTMLElement>("[data-message-id]");
  if (!row) throw new Error("Expected row");
  const inline = document.createElement("span");
  inline.dataset.reactionTool = "";
  inline.innerHTML = '<button aria-haspopup="dialog">Inline</button>';
  box("one")?.prepend(inline);
  expect(reactionTrigger(row)?.textContent).toBe("React");
  for (const button of row.querySelectorAll("button")) button.disabled = true;
  expect(reactionTrigger(row)).toBeUndefined();
});

it("prefers the list in the focused pane", () => {
  const first = fixture(["a"]);
  const pane = document.createElement("div");
  const second = fixture(["b"]);
  pane.append(second.list, second.composer);
  document.body.append(pane);
  second.composer.focus();
  expect(activeMessageList()).toBe(second.list);
  first.composer.focus();
  expect(activeMessageList()).toBe(first.list);
});

it("skips rows it can't act on: membership notices, collapsed and folded rows", () => {
  const { list, box, composer } = fixture();
  const extra = (id: string, wrap?: "hidden" | "inert") => {
    const row = document.createElement("div");
    row.dataset.messageId = id;
    row.innerHTML = '<div data-layout="timeline"></div>';
    const holder = document.createElement("div");
    if (wrap) holder.setAttribute(wrap, "");
    holder.append(row);
    return holder;
  };
  // "joined" has no row() entry, like a membership notice.
  box("two")?.parentElement?.after(extra("joined"));
  list.append(extra("collapsed", "hidden"), extra("folded", "inert"));
  selectNewestMessage(list);
  expect(document.activeElement).toBe(box("three"));
  expect(key(list, "ArrowUp")).toBe(true);
  expect(document.activeElement).toBe(box("two"));
  expect(key(list, "ArrowDown")).toBe(true);
  expect(key(list, "ArrowDown")).toBe(true);
  expect(document.activeElement).toBe(composer);
});

it("leaves keys native while the newest message is scrolled out of the window", () => {
  const { list, box } = fixture(["one", "two"], "unmounted");
  expect(selectNewestMessage(list)).toBe(false);
  box("two")?.setAttribute("tabindex", "-1");
  box("two")?.focus();
  expect(key(list, "ArrowDown")).toBe(false);
  expect(document.activeElement).toBe(box("two"));
});

it("gives plugins the lists, selection and threads through the messages service", () => {
  const { list, box, composer } = fixture();
  expect(messages.lists()).toEqual([list]);
  const row = box("two")?.parentElement as HTMLElement;
  const handle = messages.listOf(row);
  expect(handle?.element).toBe(list);
  expect(handle?.newest()).toBe("three");
  expect(handle?.has("two")).toBe(true);
  expect(handle?.has("gone")).toBe(false);
  expect(handle?.composer()).toBe(composer);
  // One handle per list, so a plugin can tell whether its owner changed.
  expect(messages.listOf(list)).toBe(handle);

  messages.select(row);
  expect(document.activeElement).toBe(box("two"));
  expect(messages.selected()).toEqual({ row, id: "two", list });
  expect(messages.focusTarget(row)).toBe(box("two"));
  expect(messages.selectNewest(list)).toBe(true);
  expect(messages.selected()?.id).toBe("three");

  // Only the row's own summary counts, not a nested reply's.
  const summary = document.createElement("button");
  summary.dataset.threadSummary = "";
  const opened = vi.fn();
  summary.addEventListener("click", opened);
  box("two")?.append(summary);
  expect(messages.hasThread(row)).toBe(true);
  expect(messages.hasThread(box("one")?.parentElement as HTMLElement)).toBe(
    false,
  );
  expect(messages.openThread(row)).toBe(true);
  expect(opened).toHaveBeenCalledOnce();

  // The Menu key opens whatever the element's own menu is.
  const menu = vi.fn((event: Event) => event.preventDefault());
  box("one")?.addEventListener("keydown", menu);
  expect(messages.openActions(box("one") as HTMLElement)).toBe(true);
  expect(menu.mock.calls[0]?.[0]).toMatchObject({ key: "ContextMenu" });
  expect(messages.openActions(box("three") as HTMLElement)).toBe(false);

  // A row that has left the page is ignored.
  row.remove();
  messages.select(row);
  expect(messages.selected()?.id).toBe("three");
});
