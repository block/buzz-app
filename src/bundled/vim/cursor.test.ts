// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import {
  registerMessageList,
  type MessageList,
} from "../../features/messages/message-selection";
import type { ChannelMessage } from "../../features/relay/contracts";
import { CURSOR, cursorRow, trackCursor } from "./cursor";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const place = (element: Element, rect: () => Partial<DOMRect>) =>
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({ top: 0, bottom: 0, height: 0, ...rect() }),
  });

/** Four 100px messages in a 300px list, scrolled by `view.offset`. */
function fixture() {
  const ids = ["one", "two", "three", "four"];
  const view = { offset: 0, ids };
  const list = document.createElement("section");
  list.style.overflowY = "auto";
  list.innerHTML = ids
    .map(
      (id) =>
        `<div data-message-id="${id}"><div data-layout="timeline" tabindex="-1">${id}</div></div>`,
    )
    .join("");
  const composer = document.createElement("textarea");
  document.body.append(list, composer);
  Object.defineProperty(list, "getClientRects", { value: () => [{}] });
  place(list, () => ({ top: 0, bottom: 300, height: 300 }));
  const box = (id: string) =>
    list.querySelector(
      `[data-message-id="${id}"] > [data-layout]`,
    ) as HTMLElement;
  for (const [index, id] of ids.entries())
    place(box(id), () => {
      const top = index * 100 - view.offset;
      return { top, bottom: top + 100, height: 100 };
    });
  cleanups.push(
    registerMessageList(list, {
      row: (id) =>
        view.ids.includes(id) ? ({ id } as ChannelMessage) : undefined,
    } as MessageList),
  );
  const marked = () =>
    [...list.querySelectorAll(`[${CURSOR}]`)].map(
      (element) =>
        element.closest<HTMLElement>("[data-message-id]")?.dataset.messageId,
    );
  return { list, composer, box, view, marked };
}

test("marks the newest message in view and follows focus and clicks", async () => {
  const { list, composer, box, marked } = fixture();
  cleanups.push(trackCursor());
  await frame();
  expect(marked()).toEqual(["three"]);

  box("one").focus();
  await frame();
  expect(marked()).toEqual(["one"]);
  // Focus elsewhere keeps it.
  composer.focus();
  await frame();
  expect(marked()).toEqual(["one"]);
  expect(cursorRow(list)?.dataset.messageId).toBe("one");

  box("two").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await frame();
  expect(marked()).toEqual(["two"]);
});

test("scrolling keeps it, and its focus, on a message in view", async () => {
  const { list, box, view, marked } = fixture();
  cleanups.push(trackCursor());
  box("one").focus();
  await frame();
  view.offset = 150;
  list.dispatchEvent(new Event("scroll"));
  await frame();
  // Off the top: the first message in view takes it.
  expect(marked()).toEqual(["two"]);
  expect(document.activeElement).toBe(box("two"));

  view.offset = -250;
  list.dispatchEvent(new Event("scroll"));
  await frame();
  // Off the bottom: the last one in view.
  expect(marked()).toEqual(["one"]);
});

test("another conversation starts from its newest message; stopping clears", async () => {
  const { list, box, view, marked } = fixture();
  const stop = trackCursor();
  box("one").focus();
  await frame();
  view.ids = ["two", "three", "four"];
  list.dispatchEvent(new Event("scroll"));
  await frame();
  expect(marked()).toEqual(["three"]);
  stop();
  expect(marked()).toEqual([]);
});
