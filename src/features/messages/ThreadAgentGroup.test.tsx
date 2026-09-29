// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";
import { ThreadAgentGroup } from "./ThreadAgentGroup";

afterEach(cleanup);
const agent = "a".repeat(64);
const session = { media: () => undefined } as unknown as RelaySession;
const profiles = new Map([[agent, { name: "Helper" }]]);
const row = (id: string) =>
  ({ id, authorId: agent, content: `Message ${id}` }) as ChannelMessage;
it("shows one collapsed control per message; pending work is separate and new coordination stays collapsed", () => {
  const collapsed = vi.fn();
  const tree = (
    ids: string[],
    reveal?: AbortSignal,
    revealMessageId?: string,
  ) => (
    <ThreadAgentGroup
      session={session}
      profiles={profiles}
      reveal={reveal}
      revealMessageId={revealMessageId}
      onHideCoordination={collapsed}
      block={{
        kind: "agents",
        id: "root",
        agents: [agent],
        rows: ids.map(row),
        tail: true,
      }}
      coordination={(item) => <li data-message-id={item.id}>{item.content}</li>}
    >
      <p>Live work status</p>
    </ThreadAgentGroup>
  );
  const view = render(tree(["first"]), { reactStrictMode: true });
  expect(screen.getByText("Live work status")).toBeVisible();
  expect(view.container.querySelector("[data-message-id]")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const first = screen.getByRole("button", { name: "Helper · Coordination" });
  fireEvent.click(first);
  expect(
    view.container.querySelector('[data-message-id="first"]'),
  ).toHaveTextContent("Message first");
  view.rerender(tree(["first", "second"]));
  expect(first).toHaveAttribute("aria-expanded", "true");
  expect(view.container.querySelector('[data-message-id="second"]')).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(2);
  fireEvent.click(first);
  expect(view.container.querySelector("[data-message-id]")).toBeNull();
  expect(collapsed).not.toHaveBeenCalled();
  expect(screen.getByText("Live work status")).toBeVisible();
  const signal = new AbortController().signal;
  view.rerender(tree(["first", "second"], signal, "second"));
  expect(view.container.querySelector('[data-message-id="first"]')).toBeNull();
  expect(
    view.container.querySelector('[data-message-id="second"]'),
  ).toHaveTextContent("Message second");
  fireEvent.click(first);
  fireEvent.click(first);
  expect(collapsed).not.toHaveBeenCalled(); // An unrelated row cannot revoke exact navigation.
  expect(
    view.container.querySelector('[data-message-id="second"]'),
  ).toBeTruthy();
  const second = screen.getAllByRole("button")[1];
  if (!second) throw new Error("Missing second disclosure");
  fireEvent.click(second);
  expect(collapsed).toHaveBeenCalledOnce();
  view.rerender(tree(["first", "second", "third"], signal, "second"));
  expect(view.container.querySelector("[data-message-id]")).toBeNull();
  view.rerender(
    tree(["first", "second", "third"], new AbortController().signal, "second"),
  );
  expect(view.container.querySelectorAll("[data-message-id]")).toHaveLength(1);
  expect(
    view.container.querySelector('[data-message-id="second"]'),
  ).toBeTruthy();
});
