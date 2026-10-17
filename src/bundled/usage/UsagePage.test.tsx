// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  SessionUsage,
} from "../../features/agents/service";
import { UsagePage } from "./UsagePage";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(cleanup);

const owner = "f".repeat(64);
const root = "e".repeat(64);
const agent = (name: string, type = "buzz.claude-code/claude"): Agent =>
  ({
    pubkey: name.padEnd(64, "0"),
    name,
    type,
    owner,
    relay: "wss://relay.example.com",
    place: "here",
    config: {},
  }) as unknown as Agent;
const session = (
  id: string,
  input: number,
  title?: string,
  model = "claude-opus-5-5",
): SessionUsage => {
  const at = new Date().setMinutes(0, 0, 0);
  return {
    id,
    revision: `${id}:${input}`,
    gaps: [],
    channelId: "chan",
    root,
    ...(title ? { title } : {}),
    startedAt: at,
    lastAt: at,
    observations: [
      {
        at,
        model,
        tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
};

/** Matches the summary sentence, which bolds its figures. */
const summary = (text: string) => (_: string, element: Element | null) =>
  element?.tagName === "P" && element.textContent === text;

/** Agents whose Claude type reads usage through `usage`. */
function host(agents: Agent[], usage: RegisteredAgentType["usage"]) {
  const snapshot = {
    status: "ready",
    agents,
    running: agents,
  } as unknown as AgentsSnapshot;
  const types = [
    {
      key: "buzz.claude-code/claude",
      title: "Claude",
      usage,
    },
    { key: "buzz.codex/codex", title: "Codex" },
  ] as unknown as RegisteredAgentType[];
  return {
    snapshot: () => snapshot,
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
}

it("summarises the agents' spend and opens a costly session's thread", async () => {
  const pixel = agent("Pixel");
  const relay = agent("Relay");
  const reads: Parameters<NonNullable<RegisteredAgentType["usage"]>>[1][] = [];
  const open = vi.fn(async () => ({ status: "opened" as const }));
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  render(
    <UsagePage
      agents={host(
        [pixel, relay, agent("Hosted", "buzz.codex/codex")],
        async (target, options) => {
          reads.push(options);
          await done;
          // $3 and $1 at Opus 5.5's $4 per million input tokens.
          return target === pixel
            ? [session("a", 750_000, "Port the scroll patch")]
            : [session("b", 250_000)];
        },
      )}
      open={open}
    />,
  );
  expect(screen.getByText("Reading your agents’ sessions…")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Refresh usage" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  finish();
  expect(
    await screen.findByText(
      summary(
        "Your 2 agents ran 2 sessions in the last 30 days. Pixel accounts for 75% of the cost, mostly on Claude Opus 5.5.",
      ),
    ),
  ).toBeTruthy();
  expect(reads).toHaveLength(2);
  // Read far enough back to compare with the previous 30 days.
  expect(Date.now() - (reads[0]?.since ?? 0)).toBeGreaterThan(59 * 86_400_000);
  const hero = screen.getByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("$4.00")).toBeTruthy();
  // The daily figures are in a table for assistive technology.
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(31);
  expect(rows.at(-1)?.textContent).toContain("$4.00");

  await userEvent.click(
    screen.getByRole("button", {
      name: /^Port the scroll patch, Pixel, \$3\.00/,
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
});

it("names the agents it could not read and reads them again", async () => {
  let fail = true;
  render(
    <UsagePage
      agents={host([agent("Pixel")], async () => {
        if (fail) throw new Error("no workspace");
        return [session("a", 250_000)];
      })}
      open={vi.fn()}
    />,
  );
  expect((await screen.findByRole("status")).textContent).toContain(
    "Couldn’t read the sessions of Pixel.",
  );
  // Filters stay reachable with no sessions to show.
  expect(screen.getByText("No sessions in this period")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Period" })).toBeTruthy();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText(
      summary("Pixel ran 1 session in the last 30 days."),
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps showing what it read before when a refresh fails", async () => {
  let fail = false;
  render(
    <UsagePage
      agents={host([agent("Pixel")], async () => {
        if (fail) throw new Error("no workspace");
        return [session("a", 250_000)];
      })}
      open={vi.fn()}
    />,
  );
  const hero = await screen.findByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("$1.00")).toBeTruthy();
  fail = true;
  await userEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect((await screen.findByRole("status")).textContent).toContain(
    "Couldn’t read the sessions of Pixel; showing what was read before.",
  );
  expect(
    within(screen.getByRole("region", { name: "Estimated cost" })).getByText(
      "$1.00",
    ),
  ).toBeTruthy();
});

it("says what it could not count instead of counting it as zero", async () => {
  render(
    <UsagePage
      agents={host([agent("Sol")], async () => [
        session("a", 1000, "Fix the build", "gpt-6.1-sol"),
      ])}
      open={vi.fn()}
    />,
  );
  const hero = await screen.findByRole("region", { name: "Estimated cost" });
  expect(within(hero).getByText("Unavailable")).toBeTruthy();
  expect(hero.textContent).toContain(
    "Not counted: gpt-6.1-sol, which have no known rates.",
  );
  expect(
    screen.getByText(summary("Sol ran 1 session in the last 30 days.")),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Fix the build, Sol, cost unavailable. Open conversation",
    }),
  ).toBeTruthy();
});

it("explains where usage comes from when no agent reports any", () => {
  render(
    <UsagePage
      agents={host([agent("Hosted", "buzz.codex/codex")], async () => [])}
      open={vi.fn()}
    />,
  );
  expect(screen.getByText("No agent usage to show")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refresh usage" })).toBeNull();
});
