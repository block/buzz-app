// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "../../features/agents/activity";
import { activityTarget } from "../../features/agents/activity-target";
import { createRelaySession } from "../../features/relay/session";
import { ActivityAccessory } from "./ActivityAccessory";

const agent = "a".repeat(64);
const other = "b".repeat(64);
const root = "c".repeat(64);
const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

function fixture() {
  const observe = vi.fn();
  const owner = createAgentActivity(true, observe, () => true);
  const base = createRelaySession(null);
  const session = { ...base.session, agentActivity: owner.queries };
  disposers.push(
    () => owner.dispose(),
    () => base.dispose(),
  );
  const release = owner.queries.activate();
  owner.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  let serial = 0;
  function turn(
    pubkey = agent,
    turnId = "one",
    channelId = "alpha",
    kind = "turn_liveness",
    age = 0,
  ) {
    owner.receive(
      {
        id: (++serial).toString(16).padStart(64, "0"),
        agent: pubkey,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind,
          channelId,
          turnId,
          timestamp: new Date(Date.now() - age).toISOString(),
        }),
      },
      observe.mock.lastCall?.[0] as number,
    );
  }
  function typing(threadRootId?: string, pubkey = agent, channelId = "alpha") {
    owner.channelEvents([
      {
        id: (++serial).toString(16).padStart(64, "0"),
        pubkey,
        kind: 20002,
        content: "",
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["h", channelId],
          ...(threadRootId
            ? [
                ["e", threadRootId, "", "root"],
                ["e", threadRootId, "", "reply"],
              ]
            : []),
        ],
      },
    ]);
  }
  const open = vi.fn(() => true);
  const canOpen = vi.fn(() => true);
  const view = (channelId = "alpha", threadRootId?: string) => (
    <StrictMode>
      <ActivityAccessory
        session={session}
        scope="test"
        channelId={channelId}
        threadRootId={threadRootId}
        canOpen={canOpen}
        open={open}
      />
    </StrictMode>
  );
  return { owner, observe, release, turn, typing, view, open, canOpen };
}

it("collapses channel-wide evidence without hiding simultaneous turns or unknown status", async () => {
  const f = fixture();
  f.turn();
  f.turn(agent, "two");
  f.turn(other, "stale", "alpha", "turn_liveness", 31_000);
  f.turn(other, "elsewhere", "beta");
  f.typing(root);
  const mounted = render(
    <>
      {f.view()}
      {f.view("alpha", root)}
    </>,
  );
  const channel = screen.getByRole("region", {
    name: "Agent activity in this channel",
  });
  const thread = screen.getByRole("region", {
    name: "Agent activity in this thread",
  });
  const summary = within(channel).getByText("Channel-wide activity · 2 agents");
  expect(within(channel).getByRole("status")).toHaveTextContent(
    "Agent aaaaaaaa is working",
  );
  expect(within(thread).getByRole("status")).toHaveTextContent(
    "Agent aaaaaaaa is working",
  );
  expect(within(channel).getByRole("status")).toHaveClass("sr-only");
  expect(channel.querySelector("details [role=status]")).toBeNull();
  expect(channel.querySelector("details")).not.toHaveAttribute("open");
  expect(
    within(channel).getByRole("button", { name: /aaaaaaaaaaaa/ }),
  ).not.toBeVisible();
  expect(within(thread).getAllByRole("button")).toHaveLength(1);
  expect(within(thread).getByRole("button")).toHaveTextContent("working");
  const user = userEvent.setup();
  await user.click(summary);
  expect(within(channel).getAllByRole("button")).toHaveLength(2);
  expect(
    within(channel).getByRole("button", { name: /aaaaaaaaaaaa/ }),
  ).toHaveTextContent("working");
  expect(
    within(channel).getByRole("button", { name: /bbbbbbbbbbbb/ }),
  ).toHaveTextContent("status unknown");
  await user.click(
    within(channel).getByRole("button", { name: /aaaaaaaaaaaa/ }),
  );
  expect(f.open).toHaveBeenCalledWith(activityTarget(agent, "alpha"));
  act(() => f.turn(agent, "one", "alpha", "turn_completed"));
  expect(channel.querySelector("details")).toHaveAttribute("open");
  expect(
    within(channel).getByRole("button", { name: /aaaaaaaaaaaa/ }),
  ).toHaveTextContent("working");
  act(() => f.turn(agent, "two", "alpha", "turn_completed"));
  // Thread typing is not proof that a channel-wide turn is still active.
  expect(
    within(channel).getByText("Channel-wide activity · 1 agent"),
  ).toBeVisible();
  expect(
    within(channel).queryByRole("button", { name: /aaaaaaaaaaaa/ }),
  ).not.toBeInTheDocument();
  expect(within(thread).getByRole("button")).toBeVisible();
  act(() => f.turn(other, "stale", "alpha", "turn_completed"));
  expect(
    screen.queryByRole("region", { name: "Agent activity in this channel" }),
  ).not.toBeInTheDocument();
  expect(within(channel).queryByRole("status")).not.toBeInTheDocument();
  expect(within(thread).getByRole("status")).toHaveTextContent(
    "Agent aaaaaaaa is working",
  );
  mounted.unmount();
  expect(f.observe).toHaveBeenCalledTimes(1); // Disclosure never owns capture.
});

it("retains expanded state on updates, resets across channels, and follows exact thread scope", async () => {
  const f = fixture();
  f.turn();
  f.turn(other, "two", "beta");
  f.typing(root);
  f.typing("d".repeat(64));
  const mounted = render(f.view());
  await userEvent
    .setup()
    .click(screen.getByText("Channel-wide activity · 1 agent"));
  act(() => f.turn(agent, "refresh"));
  expect(screen.getByRole("button")).toBeVisible();
  mounted.rerender(f.view("beta"));
  expect(screen.getByRole("button")).not.toBeVisible();
  expect(screen.getByText("Channel-wide activity · 1 agent")).toBeVisible();
  mounted.rerender(f.view("alpha", root));
  expect(screen.getByRole("button")).toBeVisible();
  mounted.rerender(f.view("alpha", "e".repeat(64)));
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  mounted.rerender(f.view("alpha", "d".repeat(64)));
  expect(screen.getByRole("button")).toBeVisible();
  act(f.release);
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});

it("keeps channel typing inspectable, expires thread evidence independently, and preserves unknown telemetry", () => {
  vi.useFakeTimers();
  const f = fixture();
  f.turn();
  f.typing();
  f.typing(root);
  render(
    <>
      {f.view()}
      {f.view("alpha", root)}
    </>,
  );
  expect(screen.getByText("Channel-wide activity · 1 agent")).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Agent activity in this thread" }),
  ).toBeVisible();
  act(() => vi.advanceTimersByTime(9000));
  expect(
    screen.queryByRole("region", { name: "Agent activity in this thread" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Channel-wide activity · 1 agent")).toBeVisible();
  act(() => f.owner.state({ status: "retrying", routes: [] }));
  // Stale/unknown evidence is not presented as a count of working agents.
  expect(screen.getByText("Channel-wide activity · 1 agent")).toBeVisible();
  expect(screen.getByText("status unknown")).not.toBeVisible();
  act(f.release);
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});

it("omits unavailable destinations from the summary and hides when none can open", () => {
  const f = fixture();
  f.turn();
  f.turn(other);
  f.canOpen.mockImplementation(
    (...args: unknown[]) => args[0] === activityTarget(agent, "alpha"),
  );
  const mounted = render(f.view());
  expect(screen.getByText("Channel-wide activity · 1 agent")).toBeVisible();
  f.canOpen.mockReturnValue(false);
  mounted.rerender(f.view());
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});
