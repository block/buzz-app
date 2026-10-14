// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import type {
  Agent,
  Agents,
  AgentSession,
} from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { meTarget } from "../me/routes";
import { SwitchboardPage } from "./SwitchboardPage";

stubAvatarBrowserApis();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
const viewer = "c".repeat(64);
const sol = "a".repeat(64);
const orc = "b".repeat(64);
const root = "d".repeat(64);
const origin = "https://relay.test";
const scope = { viewer, communityOrigin: origin };
const partition = `${origin}:${viewer}`;
const me = "11111111-1111-4111-8111-111111111111";

function fixture(sessions: Record<string, AgentSession[]>) {
  const owner = createRelaySession(null);
  owners.push(owner);
  const list = {
    status: "ready" as const,
    channels: [
      { id: "general", name: "general" },
      { id: "dm", name: "", channelType: "dm" as const, participants: [orc] },
      { id: me, name: "Planning", channelType: "session" as const },
    ],
  };
  const session = {
    ...owner.session,
    viewer,
    channels: { ...owner.session.channels, list: () => list, ensureList() {} },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 0,
    scope: partition,
    viewer,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const listeners = new Set<() => void>();
  const agent = (pubkey: string, name: string) =>
    ({ pubkey, name, type: "buzz.codex/codex", place: "here" }) as Agent;
  const roster = [agent(sol, "Sol"), agent(orc, "Orc")];
  const types = [
    {
      key: "buzz.codex/codex",
      sessions: {
        list: (pubkey: string) => sessions[pubkey] ?? [],
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  ];
  const agents = {
    types: () => types,
    snapshot: () => ({ status: "ready", agents: roster }),
    subscribe: () => () => {},
    find: (pubkey: string) => roster.find((a) => a.pubkey === pubkey),
  } as unknown as Agents;
  const open = vi.fn(async () => ({ status: "opened" as const }));
  render(
    <SwitchboardPage
      relay={relay}
      agents={agents}
      navigator={{ open } as unknown as Navigation}
    />,
  );
  const notify = () =>
    act(() => {
      for (const listener of listeners) listener();
    });
  return { open, notify };
}

const rows = () =>
  screen
    .queryAllByRole("button", { name: /^Open / })
    .map((row) => row.getAttribute("aria-label"));

it("lists sessions newest first and opens where each is messaged", async () => {
  const user = userEvent.setup();
  const { open } = fixture({
    [sol]: [
      { channelId: "general", root, at: 3000, status: "Working" },
      { channelId: me, at: 1000 },
    ],
    [orc]: [{ channelId: "dm", at: 2000, status: "Idle" }],
  });
  expect(rows()).toEqual([
    "Open Sol in #general",
    "Open Orc in DM · Orc",
    "Open Sol in Planning",
  ]);
  expect(screen.getByText("Sol · Thread · Working")).toBeInTheDocument();
  expect(screen.getByText("Orc · Idle")).toBeInTheDocument();

  await user.click(
    screen.getByRole("button", { name: "Open Sol in #general" }),
  );
  expect(open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "general",
    messageId: root,
    threadRootId: root,
  });
  await user.click(
    screen.getByRole("button", { name: "Open Orc in DM · Orc" }),
  );
  expect(open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "dm",
  });
  await user.click(
    screen.getByRole("button", { name: "Open Sol in Planning" }),
  );
  expect(open).toHaveBeenLastCalledWith(meTarget(partition, me));
});

it("archives one session until its next turn starts", async () => {
  const user = userEvent.setup();
  const now = vi.spyOn(Date, "now").mockReturnValue(5000);
  const sessions: Record<string, AgentSession[]> = {
    [sol]: [
      { channelId: "general", at: 3000 },
      { channelId: me, at: 1000 },
    ],
  };
  const { notify } = fixture(sessions);
  await user.click(
    screen.getByRole("button", { name: "Archive Sol in #general" }),
  );
  // The agent's other session stays.
  expect(rows()).toEqual(["Open Sol in Planning"]);
  await user.click(screen.getByRole("tab", { name: "Archived" }));
  expect(rows()).toEqual(["Open Sol in #general"]);

  // A status change without a new turn does not reopen it.
  sessions[sol] = [{ channelId: "general", at: 3000, status: "Idle" }];
  notify();
  expect(rows()).toEqual(["Open Sol in #general"]);

  sessions[sol] = [{ channelId: "general", at: 6000, status: "Working" }];
  notify();
  expect(rows()).toEqual([]);
  await user.click(screen.getByRole("tab", { name: "Active" }));
  expect(rows()).toEqual(["Open Sol in #general"]);
  now.mockRestore();
});

it("restores an archived session", async () => {
  const user = userEvent.setup();
  fixture({ [sol]: [{ channelId: "general", at: 3000 }] });
  await user.click(
    screen.getByRole("button", { name: "Archive Sol in #general" }),
  );
  expect(screen.getByText("No agent sessions")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Archived" }));
  await user.click(
    screen.getByRole("button", { name: "Restore Sol in #general" }),
  );
  await user.click(screen.getByRole("tab", { name: "Active" }));
  expect(rows()).toEqual(["Open Sol in #general"]);
});
