// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  registerMessageList,
  type MessageList,
} from "../../features/messages/message-selection";
import type { ChannelMessage } from "../../features/relay/contracts";
import { Context } from "@deepseek-ai/cordis";
import { MessagesService } from "../../features/messages/messages-service";
import { claim, CURSOR, currentCursor, trackCursor } from "./cursor";
import { host } from "./host";

host.messages = new MessagesService(new Context());

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** A conversation workspace with a composer and a list of messages. */
function conversation(channel = "alpha", ids = ["one", "two", "three"]) {
  const view = { ids: [...ids] };
  const main = document.createElement("main");
  main.id = "main-content";
  main.innerHTML = `<div data-channel-workspace="${channel}"><section></section><div role="textbox" contenteditable="true"></div></div>`;
  document.body.append(main);
  const workspace = main.firstElementChild as HTMLElement;
  const list = workspace.querySelector("section") as HTMLElement;
  const composer = workspace.querySelector<HTMLElement>('[role="textbox"]');
  const render = () => {
    list.innerHTML = view.ids
      .map(
        (id) =>
          `<div data-message-id="${id}"><div data-layout="timeline" tabindex="-1">${id}<button>part</button></div></div>`,
      )
      .join("");
  };
  render();
  const pins: string[] = [];
  const controller = {
    row: (id: string) =>
      view.ids.includes(id) ? ({ id } as ChannelMessage) : undefined,
    newest: () => view.ids.at(-1),
    keepMounted: vi.fn((id: string) => {
      pins.push(id);
      return () => pins.splice(pins.indexOf(id), 1);
    }),
  } as unknown as MessageList;
  const unregister = registerMessageList(list, controller);
  cleanups.push(() => unregister());
  const box = (id: string) =>
    list.querySelector(
      `[data-message-id="${id}"] > [data-layout]`,
    ) as HTMLElement;
  const marked = () =>
    [...list.querySelectorAll(`[${CURSOR}]`)].map(
      (element) =>
        element.closest<HTMLElement>("[data-message-id]")?.dataset.messageId,
    );
  return {
    workspace,
    list,
    composer,
    box,
    view,
    render,
    pins,
    marked,
    unregister,
  };
}

test("an opened conversation selects and focuses its newest message, kept mounted", async () => {
  const { box, composer, marked, pins } = conversation();
  // The host's initial focus goes to the composer; the cursor takes it back.
  composer?.focus();
  cleanups.push(trackCursor());
  await frame();
  expect(marked()).toEqual(["three"]);
  expect(document.activeElement).toBe(box("three"));
  expect(pins).toEqual(["three"]);
});

test("focus and clicks move it; typing, scrolling and focus elsewhere keep it, unmarked", async () => {
  const { workspace, list, box, composer, marked, pins } = conversation();
  cleanups.push(trackCursor());
  await frame();
  box("one").focus();
  await frame();
  expect(marked()).toEqual(["one"]);
  expect(pins).toEqual(["one"]);

  // The reader's own key (i) ends the opened conversation's claim on focus.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
  composer?.focus();
  list.dispatchEvent(new Event("scroll"));
  await frame();
  // The cursor is where focus is; the message is only remembered.
  expect(marked()).toEqual([]);
  expect(currentCursor()?.dataset.messageId).toBe("one");
  expect(document.activeElement).toBe(composer);
  // The conversation blanking while it reloads does not open it again.
  workspace.dataset.channelWorkspace = "";
  await frame();
  workspace.dataset.channelWorkspace = "alpha";
  await frame();
  expect(document.activeElement).toBe(composer);

  box("two").dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await frame();
  expect(currentCursor()?.dataset.messageId).toBe("two");
});

test("focus that falls to nothing, or a click in the timeline, returns to it", async () => {
  const { list, box, marked } = conversation();
  cleanups.push(trackCursor());
  await frame();
  // The reader's own key ends the opened conversation's claim on focus.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
  box("two").focus();
  await frame();
  (document.activeElement as HTMLElement).blur();
  // It must stay nowhere for a frame: focus can pass through on its way back.
  await frame();
  expect(document.activeElement).toBe(document.body);
  await frame();
  expect(document.activeElement).toBe(box("two"));

  // A click on the timeline's empty space focuses the list itself.
  list.tabIndex = 0;
  list.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  list.focus();
  list.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await frame();
  expect(marked()).toEqual(["two"]);
  expect(document.activeElement).toBe(box("two"));

  // A click on a message's part leaves focus on that part.
  const part = box("one").querySelector("button") as HTMLElement;
  part.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  part.focus();
  part.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await frame();
  expect(marked()).toEqual(["one"]);
  expect(document.activeElement).toBe(part);

  // A key's own click (Enter opening a thread) counts only until the next key.
  claim(() => box("two"));
  list.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await frame();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\" }));
  const outside = document.body.appendChild(document.createElement("button"));
  outside.focus();
  await frame();
  expect(document.activeElement).toBe(outside);
});

test("a new message leaves the selection where it is", async () => {
  const { box, view, render, marked } = conversation();
  cleanups.push(trackCursor());
  await frame();
  box("two").focus();
  await frame();
  view.ids.push("four");
  render();
  await frame();
  expect(marked()).toEqual(["two"]);
});

test("a deleted message passes the cursor to its neighbor", async () => {
  const { box, view, render, marked, pins } = conversation("alpha", [
    "one",
    "two",
    "three",
    "four",
  ]);
  cleanups.push(trackCursor());
  await frame();
  box("two").focus();
  await frame();
  view.ids = ["one", "three", "four"];
  render();
  await frame();
  expect(marked()).toEqual(["three"]);
  expect(pins).toEqual(["three"]);
  // The last one: the message before it.
  box("four").focus();
  await frame();
  view.ids = ["one", "three"];
  render();
  await frame();
  expect(marked()).toEqual(["three"]);
});

test("each conversation keeps its own cursor across a visit elsewhere", async () => {
  const alpha = conversation("alpha");
  cleanups.push(trackCursor());
  await frame();
  alpha.box("one").focus();
  await frame();

  // Beta replaces the conversation in the same workspace.
  alpha.unregister();
  document.body.replaceChildren();
  const beta = conversation("beta", ["b1", "b2"]);
  await frame();
  expect(beta.marked()).toEqual(["b2"]);
  expect(document.activeElement).toBe(beta.box("b2"));

  beta.unregister();
  document.body.replaceChildren();
  const again = conversation("alpha");
  await frame();
  expect(again.marked()).toEqual(["one"]);
  expect(document.activeElement).toBe(again.box("one"));
});

test("a dialog keeps focus, and stopping clears the marks and pins", async () => {
  const { box, marked, pins } = conversation();
  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = "<button>OK</button>";
  document.body.append(dialog);
  const stop = trackCursor();
  await frame();
  expect(document.activeElement).not.toBe(box("three"));
  dialog.remove();
  await frame();
  expect(document.activeElement).toBe(box("three"));
  stop();
  expect(marked()).toEqual([]);
  expect(pins).toEqual([]);
});

test("turning the plugin off and on keeps the cursor when the old stop runs last", async () => {
  const { box, marked, pins } = conversation();
  const stopOld = trackCursor();
  await frame();
  // Disabling finishes after a render, so the re-enable starts first.
  cleanups.push(trackCursor());
  stopOld();
  await frame();
  expect(marked()).toEqual(["three"]);
  expect(pins).toEqual(["three"]);
  // Enter into a thread claims focus through the live tracker.
  claim(() => box("one"));
  await frame();
  expect(document.activeElement).toBe(box("one"));
});
