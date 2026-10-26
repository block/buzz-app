// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { AgentShareDialog } from "./AgentShareDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const owner = "f".repeat(64);
const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner,
  relay: "wss://relay.example",
  place: "here",
  config: { instructions: "Review pull requests.", model: "echo-1" },
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
};
const echo = {
  key: "test/echo",
  title: "Echo",
  carry: (saved: { instructions: string }) => ({
    instructions: saved.instructions,
  }),
  exportShared: (saved: { model: string }) => ({
    runtime: "echo",
    model: saved.model,
  }),
} as unknown as RegisteredAgentType;

/** A community whose catalog holds the heads its outbox accepted. */
function community() {
  const heads: EventData[] = [];
  const listeners = new Set<() => void>();
  let pending: { id: string; event: EventData } | undefined;
  const outbox = {
    supports: (kind: number) => kind === 30175,
    ready: async () => {},
    send: vi.fn((input: Pick<EventData, "kind" | "content" | "tags">) => {
      const event = {
        ...input,
        id: String(heads.length + 1).repeat(64),
        pubkey: owner,
        created_at: heads.length + 1,
      } as EventData;
      pending = { id: event.id, event };
      return event.id;
    }),
    snapshot: () =>
      pending ? [{ event: pending.event, delivery: "sending" }] : [],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: vi.fn(async () => {}),
  };
  /** The relay accepts what was sent. */
  const accept = () => {
    if (pending) heads.push(pending.event);
    pending = undefined;
    for (const listener of listeners) listener();
  };
  const read = vi.fn(async () => [...heads]);
  return {
    session: { read, outbox } as unknown as RelaySession,
    outbox,
    accept,
  };
}

it("shares the agent to its community's catalog and unshares what it shared", async () => {
  const user = userEvent.setup();
  const { session, outbox, accept } = community();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Share Ada" });
  const toggle = within(dialog).getByRole("switch", {
    name: "Share to catalog",
  });
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  const sharedContent = JSON.stringify({
    display_name: "Ada",
    system_prompt: "Review pull requests.",
    runtime: "echo",
    model: "echo-1",
  });
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [
        ["d", agent.pubkey],
        ["shared", "true"],
      ],
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await within(dialog).findByText("Published Ada to the community catalog."),
  ).toBeInTheDocument();
  expect(toggle).toBeChecked();

  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  // Unsharing replaces the shared head with what it shared.
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [["d", agent.pubkey]],
      supersedes: 1,
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await within(dialog).findByText(
      "Ada is no longer discoverable in the community catalog.",
    ),
  ).toBeInTheDocument();
  expect(toggle).not.toBeChecked();
});

it("says why sharing failed and keeps the catalog as it was", async () => {
  const user = userEvent.setup();
  const { session, outbox } = community();
  render(
    <AgentShareDialog
      agent={{
        ...agent,
        config: { instructions: "password: hunter2hunter2", model: "" },
      }}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const toggle = screen.getByRole("switch", { name: "Share to catalog" });
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  await user.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to update catalog sharing. Portable configuration appears to contain a credential. Remove it before export.",
  );
  expect(outbox.send).not.toHaveBeenCalled();
  expect(toggle).not.toBeChecked();
});

it("exports the agent as an .agent.json snapshot", async () => {
  const user = userEvent.setup();
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return "blob:snapshot";
    },
    revokeObjectURL: () => {},
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("Ada.agent.json");
      expect(this.href).toBe("blob:snapshot");
    });
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={community().session}
      onClose={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Export agent" }));
  expect(click).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await blobs[0]?.text()) ?? "")).toEqual({
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: "Ada",
      systemPrompt: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    },
    profile: { displayName: "Ada" },
    memory: { level: "none", entries: [] },
  });
  expect(screen.getByRole("status")).toHaveTextContent("Exported Ada.");
  click.mockRestore();
});
