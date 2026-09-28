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
const request = {
  agents: [agent],
  message: {
    id: "root",
    channelId: "c",
    authorId: "viewer",
    createdAt: 1,
    content: "Request",
    mentions: [agent],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  } satisfies ChannelMessage,
};
it("opening progress never opts into incoming coordination; transcript intent and exact reveal are separate", () => {
  const collapsed = vi.fn();
  const tree = (count = 0, reveal?: AbortSignal) => (
    <ThreadAgentGroup
      session={session}
      profiles={profiles}
      reveal={reveal}
      onHideCoordination={collapsed}
      block={{
        kind: "agents",
        id: "root",
        agents: [agent],
        rows: Array.from(
          { length: count },
          (_, i) => ({ id: `coord-${i}`, authorId: agent }) as ChannelMessage,
        ),
        request,
        tail: true,
      }}
      coordination={
        <ol>
          {Array.from({ length: count }, (_, i) => ({
            id: `coord-${i}`,
            content: `Coordination ${i}`,
          })).map((row) => (
            <li key={row.id} data-message-id={row.id}>
              {row.content}
            </li>
          ))}
        </ol>
      }
    >
      <p>Live work status</p>
    </ThreadAgentGroup>
  );
  const view = render(tree(), { reactStrictMode: true });
  const header = screen.getByRole("button", {
    name: "1 agent · Activity · 1 awaiting reply",
  });
  fireEvent.click(header);
  expect(screen.getByText("Live work status")).toBeVisible();
  view.rerender(tree(1));
  expect(header).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByText("Coordination 0")).toBeNull();
  const transcript = screen.getByRole("button", {
    name: "View 1 coordination message",
  });
  expect(transcript).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(transcript);
  expect(screen.getByText("Coordination 0")).toBeVisible();
  view.rerender(tree(2));
  expect(screen.getByText("Coordination 1")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Hide coordination messages" }),
  );
  expect(screen.queryByText("Coordination 0")).toBeNull();
  expect(screen.getByText("Live work status")).toBeVisible();
  expect(collapsed).toHaveBeenCalledOnce();
  view.rerender(tree(3));
  expect(screen.queryByText("Coordination 2")).toBeNull();
  const signal = new AbortController().signal;
  view.rerender(tree(3, signal));
  expect(screen.getByText("Coordination 2")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Hide coordination messages" }),
  );
  view.rerender(tree(4, signal));
  expect(screen.queryByText("Coordination 2")).toBeNull(); // Old navigation cannot undo manual hide.
  view.rerender(tree(4, new AbortController().signal));
  expect(screen.getByText("Coordination 3")).toBeVisible(); // A new exact navigation can.
  fireEvent.click(header);
  expect(screen.queryByText("Live work status")).toBeNull();
  expect(screen.queryByText("Coordination 2")).toBeNull();
  fireEvent.click(header);
  expect(screen.getByText("Live work status")).toBeVisible();
  expect(screen.queryByText("Coordination 2")).toBeNull();
  expect(
    screen.getByRole("button", { name: "View 4 coordination messages" }),
  ).toHaveAttribute("aria-expanded", "false");
});
