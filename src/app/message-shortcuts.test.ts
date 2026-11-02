// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../features/relay/contracts";
import {
  registerMessageList,
  selectMessage,
  type MessageList,
} from "../features/messages/message-selection";
import { createShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutsService } from "../features/shortcuts/service";
import { createAppearance } from "../shared/theme/service";
import { registerAppShortcuts } from "./shortcuts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

function setup(own: boolean, reply = vi.fn()) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const shortcuts = new ShortcutsService(
    root,
    window,
    createShortcutBindings(window),
  );
  cleanups.push(
    registerAppShortcuts(shortcuts, createAppearance(window), vi.fn(), true),
  );
  const list = document.createElement("section");
  list.innerHTML =
    '<div data-message-id="one"><div data-layout="timeline">One' +
    '<div role="group"><button aria-label="Reply">Reply</button></div>' +
    "</div></div>";
  document.body.append(list);
  list.querySelector("button")?.addEventListener("click", reply);
  const controller: MessageList = {
    row: (id) => ({ id }) as ChannelMessage,
    newest: () => "one",
    canEdit: () => false,
    edit: vi.fn(),
    canDelete: () => own,
    remove: vi.fn(),
    canMarkUnread: () => true,
    markUnread: vi.fn(),
    composer: () => null,
  };
  cleanups.push(registerMessageList(list, controller));
  const row = list.querySelector<HTMLElement>("[data-message-id]");
  if (row) selectMessage(row);
  return { controller, reply };
}

const press = (key: string) => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event.defaultPrevented;
};

it("deletes, marks unread and replies to the selected message with Slack's keys", () => {
  const { controller, reply } = setup(true);
  expect(press("Backspace")).toBe(true);
  expect(press("Delete")).toBe(true);
  expect(controller.remove).toHaveBeenCalledTimes(2);
  expect(press("u")).toBe(true);
  expect(controller.markUnread).toHaveBeenCalledWith({ id: "one" });
  expect(press("t")).toBe(true);
  expect(press("ArrowRight")).toBe(true);
  expect(reply).toHaveBeenCalledTimes(2);
});

it("leaves Delete alone on someone else's message and without a selection", () => {
  const { controller } = setup(false);
  expect(press("Backspace")).toBe(false);
  expect(controller.remove).not.toHaveBeenCalled();
  (document.activeElement as HTMLElement | null)?.blur();
  expect(press("u")).toBe(false);
  expect(controller.markUnread).not.toHaveBeenCalled();
});
