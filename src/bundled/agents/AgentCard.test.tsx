// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { PresenceStatus } from "../../features/presence/presence";
import { AgentCard } from "./AgentCard";

afterEach(cleanup);

it("badges a single agent only while live presence is known", () => {
  const pubkey = "a".repeat(64);
  let status: PresenceStatus = "unknown";
  let changed = () => {};
  const session = {
    presence: {
      status: () => status,
      limited: () => false,
      subscribe: (_key: string, listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
  } as unknown as RelaySession;
  render(
    <AgentCard
      name="Agent"
      identities={[{ pubkey, name: "Agent" }]}
      session={session}
    />,
  );
  const artwork = screen.getByRole("img", { name: "Agent" });
  expect(artwork).toHaveAttribute("data-avatar-shape", "squircle");
  expect(artwork.closest(".buzz-avatar-status")).toBeNull();
  for (const next of ["online", "away", "offline", "unknown"] as const) {
    act(() => {
      status = next;
      changed();
    });
    const updated = screen.getByRole("img", {
      name: next === "unknown" ? "Agent" : `Agent, ${next}`,
    });
    const badge = updated.closest(".buzz-avatar-status");
    if (next === "unknown") expect(badge).toBeNull();
    else expect(badge).toHaveAttribute("data-status", next);
  }
});
