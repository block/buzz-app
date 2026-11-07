// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  SessionUsage,
} from "../../features/agents/service";
import { apply } from "./index";
import { todayStore } from "./today";
import { setSpendBesideSend } from "./today-preference";
import { TodaySpend } from "./TodaySpend";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const owner = "f".repeat(64);
const root = "e".repeat(64);
const agent = (name: string, type = "buzz.claude-code/claude"): Agent =>
  ({
    key: name.padEnd(64, "0"),
    pubkey: name.padEnd(64, "0"),
    name,
    type,
    owner,
    relay: "wss://relay.example.com",
    place: "here",
    config: {},
  }) as unknown as Agent;
const session = (id: string, usd?: number): SessionUsage => {
  const at = new Date().setMinutes(0, 0, 0);
  return {
    id,
    revision: id,
    gaps: [],
    channelId: "chan",
    root,
    startedAt: at,
    lastAt: at,
    observations: [
      {
        at,
        // A model no price data knows: without a recorded cost it is unknown.
        model: "example-unpriced-model",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        ...(usd !== undefined ? { cost: { usd, source: "test" } } : {}),
      },
    ],
  };
};
function host(agents: Agent[], usage: RegisteredAgentType["usage"]) {
  const snapshot = {
    status: "ready",
    agents,
    running: agents,
  } as unknown as AgentsSnapshot;
  const types = [
    { key: "buzz.claude-code/claude", title: "Claude", usage },
  ] as unknown as RegisteredAgentType[];
  return {
    snapshot: () => snapshot,
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
}

it("shows nothing until its setting is on", async () => {
  const usage = vi.fn(async () => [session("s", 1)]);
  const store = todayStore(host([agent("Pixel")], usage));
  render(<TodaySpend store={store} open={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(usage).not.toHaveBeenCalled();

  act(() => {
    setSpendBesideSend(true);
  });
  expect(
    await screen.findByRole("button", {
      name: "Your agents’ estimated spend today: $1.00",
    }),
  ).toBeTruthy();
});

it("lists each agent's spend, unknown as —, and opens its latest conversation", async () => {
  setSpendBesideSend(true);
  const pixel = agent("Pixel");
  const fizz = agent("Fizz");
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const store = todayStore(
    host([pixel, fizz], async (target) =>
      target === pixel ? [session("p", 6.84)] : [session("f")],
    ),
  );
  render(<TodaySpend store={store} open={open} />);
  const trigger = await screen.findByRole("button", {
    name: "Your agents’ estimated spend today: $6.84 · partial",
  });
  // Partial is named in the label, not marked on the number.
  expect(trigger.textContent).toBe("$6.84");
  await userEvent.click(trigger);
  expect(await screen.findByText("Estimated")).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Fizz, cost unavailable. Open its latest conversation",
    }),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", {
      name: "Pixel, $6.84. Open its latest conversation",
    }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    scope: { viewer: owner, communityOrigin: "https://relay.example.com" },
    channelId: "chan",
    messageId: root,
    threadRootId: root,
  });
  // The composer stays when that conversation is this one: the card closes
  // and focus goes back to the amount.
  await vi.waitFor(() => expect(screen.queryByText("Estimated")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

it("lists every agent in one list, and a second press closes the card", async () => {
  setSpendBesideSend(true);
  const names = ["Pixel", "Honey", "Ledger", "Scout", "Atlas", "Quill", "Fizz"];
  const agents = names.map((name) => agent(name));
  const store = todayStore(
    host(agents, async (target) => [
      session(target.name, names.length - names.indexOf(target.name)),
    ]),
  );
  render(<TodaySpend store={store} open={vi.fn()} />);
  const trigger = await screen.findByRole("button", {
    name: "Your agents’ estimated spend today: $28.00",
  });
  await userEvent.click(trigger);
  const list = await screen.findByRole("list", { name: "By agent" });
  expect(list.querySelectorAll("li")).toHaveLength(names.length);
  expect(screen.queryByText(/more$/)).toBeNull();
  await userEvent.click(trigger);
  await vi.waitFor(() => expect(screen.queryByText("Estimated")).toBeNull());
});

it("opens from the keyboard and closes on Escape", async () => {
  setSpendBesideSend(true);
  const store = todayStore(
    host([agent("Pixel")], async () => [session("s", 2)]),
  );
  render(<TodaySpend store={store} open={vi.fn()} />);
  const trigger = await screen.findByRole("button", {
    name: "Your agents’ estimated spend today: $2.00",
  });
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByText("Estimated")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.queryByText("Estimated")).toBeNull());
});

it("shows no amount in a thread's composer, only its channel's", async () => {
  setSpendBesideSend(true);
  const agents = host([agent("Pixel")], async () => [session("s", 2)]);
  let tool: { component: ComponentType<{ threadRootId?: string }> } | undefined;
  apply({
    agents,
    navigation: { open: vi.fn() },
    settingsCards: { register: () => {} },
    conversation: {
      registerTool: (value: typeof tool) => {
        tool = value;
      },
    },
    effect: () => {},
  } as unknown as Parameters<typeof apply>[0]);
  const Tool = tool?.component;
  if (!Tool) throw new Error("No tool registered");
  render(<Tool threadRootId={root} />);
  render(<Tool />);
  expect(
    await screen.findAllByRole("button", {
      name: "Your agents’ estimated spend today: $2.00",
    }),
  ).toHaveLength(1);
});
