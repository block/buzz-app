// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { ChatIconSlot, ChatIcons } from "./ChatIconSlot";
import type { Conversation } from "./service";

afterEach(cleanup);
const session = {} as RelaySession;
type Icons = Conversation["chatIcons"];
const icons = (entries: ReturnType<Icons["snapshot"]>): Icons => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const entry = (component: ReturnType<Icons["snapshot"]>[number]["component"]) =>
  ({ id: "chat-icon", key: "fixture/chat-icon", component }) as ReturnType<
    Icons["snapshot"]
  >[number];

it("shows the plugin's icon for the chat, and nothing when none is registered", () => {
  const registry = icons([
    entry(({ channelId, fallback }) =>
      channelId === "linked" ? <span>pull request</span> : fallback,
    ),
  ]);
  render(
    <ChatIcons value={registry}>
      <ChatIconSlot session={session} channelId="linked" />
      <ChatIconSlot session={session} channelId="plain" />
    </ChatIcons>,
  );
  expect(screen.getAllByText("pull request")).toHaveLength(1);
  cleanup();
  const { container } = render(
    <ChatIconSlot session={session} channelId="linked" />,
  );
  expect(container.textContent).toBe("");
});

it("a failing icon leaves the row with its fallback", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const registry = icons([
    entry(() => {
      throw new Error("broken icon");
    }),
  ]);
  render(
    <ChatIcons value={registry}>
      <ChatIconSlot
        session={session}
        channelId="linked"
        fallback={<span>chat</span>}
      />
    </ChatIcons>,
  );
  expect(screen.getByText("chat")).toBeTruthy();
  error.mockRestore();
});
