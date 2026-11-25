// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, test } from "vitest";
import {
  type MessageList,
  registerMessageList,
} from "../../features/messages/message-selection";
import { MessagesService } from "../../features/messages/messages-service";
import type { ChannelMessage } from "../../features/relay/contracts";
import { host } from "./host";
import { cancelMoves, leave, openActions } from "./motion";

host.messages = new MessagesService(new Context());
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

const frames = async (count: number) => {
  for (let i = 0; i < count; i++)
    await new Promise((resolve) => requestAnimationFrame(resolve));
};

/** A selected message whose action menu renders a frame after it opens. */
function message() {
  document.body.innerHTML = `<main id="main-content"><div data-channel-workspace="alpha"><section><div data-message-id="one"><div data-layout="timeline" tabindex="-1">one</div></div></section></div></main>`;
  const list = document.querySelector("section") as HTMLElement;
  cleanups.push(
    registerMessageList(list, {
      row: (id: string) => ({ id }) as ChannelMessage,
      newest: () => "one",
    } as unknown as MessageList),
  );
  const row = list.querySelector<HTMLElement>(
    "[data-message-id]",
  ) as HTMLElement;
  host.messages.select(row);
  const opens = (event: KeyboardEvent) => {
    if (event.key !== "ContextMenu") return;
    event.preventDefault();
    requestAnimationFrame(() =>
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="menu" data-open tabindex="-1"></div>`,
      ),
    );
  };
  document.addEventListener("keydown", opens);
  cleanups.push(() => document.removeEventListener("keydown", opens));
  return host.messages.focusTarget(row);
}

test("a move still waiting on a frame ends when Vim keys stops or a newer move starts", async () => {
  // Without a stop, go hands focus to the menu once it renders.
  message();
  expect(openActions()).toBe(true);
  await frames(3);
  expect(document.activeElement?.getAttribute("role")).toBe("menu");

  // Stopped while it waits, it leaves focus where it was.
  const box = message();
  expect(openActions()).toBe(true);
  cancelMoves();
  await frames(3);
  expect(document.activeElement).toBe(box);

  // A newer move, here Escape back to the message, wins over one waiting.
  const left = message();
  expect(openActions()).toBe(true);
  leave();
  await frames(3);
  expect(document.activeElement).toBe(left);
});
