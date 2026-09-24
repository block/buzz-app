// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Outbox, OutgoingEvent } from "../../features/relay/outbox";
import { createRelayProfiler } from "../../features/relay/profiling";
import { OutboxStatus } from "./OutboxStatus";

afterEach(cleanup);
const invitation = {
  event: {
    id: "invite",
    kind: 9000,
    content: "",
    tags: [["p", "a".repeat(64)]],
  },
  delivery: "failed",
} as OutgoingEvent;
function show(item: OutgoingEvent) {
  const retry = vi.fn();
  const items = [item];
  const outbox = {
    snapshot: () => items,
    subscribe: () => () => {},
    retry,
    dismiss: vi.fn(),
  } as unknown as Outbox;
  render(<OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />);
  fireEvent.click(screen.getByText("Outbox · 1 items"));
  return retry;
}

it("does not offer generic retry for guarded invitations from either profile or composer", () => {
  const retry = show({ ...invitation, guarded: true });
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/Retry from the channel or agent profile/),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Remove from outbox" }),
  ).toBeVisible();
  expect(retry).not.toHaveBeenCalled();
});

it("does not show private feedback body or generic retry in the channel outbox", () => {
  const retry = vi.fn();
  const items = [
    {
      ...invitation,
      event: { ...invitation.event, kind: 42000, content: "private report" },
    },
  ];
  const outbox = {
    snapshot: () => items,
    subscribe: () => () => {},
    retry,
    dismiss: vi.fn(),
  } as unknown as Outbox;
  render(<OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />);
  fireEvent.click(screen.getByText("Outbox · 0 items"));
  expect(screen.queryByText(/private report/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(retry).not.toHaveBeenCalled();
});

it("preserves generic retry for legacy unguarded invitations", () => {
  const retry = show(invitation);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledWith("invite");
});
