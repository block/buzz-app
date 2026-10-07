// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AttentionPanel, describeWatch } from "./AttentionPanel";
import type { Agent } from "./service";

afterEach(cleanup);

const agent: Agent = {
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  config: {},
  attention: {
    "interest/release-triage": {
      slug: "interest/release-triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Keep releases moving." },
    },
    "watch/questions": {
      slug: "watch/questions",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "release-triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
      },
    },
  },
};

it("names watches by what and where they wake", () => {
  const watch = agent.attention["watch/questions"]?.value;
  if (watch?.type !== "event") throw new Error("fixture");
  expect(describeWatch(watch, [{ id: "c1", name: "releases" }])).toBe(
    "Messages in #releases",
  );
  expect(describeWatch(watch)).toBe("Messages in 1 channel");
  expect(describeWatch({ ...watch, channels: "all", kinds: [] })).toBe(
    "Any event in any channel",
  );
});

it("groups watches under their interest, pauses them, and adds timers", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(
    <AttentionPanel
      agent={agent}
      save={save}
      channels={[{ id: "c1", name: "releases" }]}
    />,
  );
  const group = screen.getByRole("region", { name: "Release triage" });
  expect(within(group).getByText("Keep releases moving.")).toBeInTheDocument();

  await user.click(
    within(group).getByRole("switch", { name: "Messages in #releases on" }),
  );
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "watch/questions": expect.objectContaining({ enabled: false }),
    },
  });

  await user.click(within(group).getByRole("button", { name: "Timer" }));
  await user.type(screen.getByLabelText("Prompt"), "Summarise blockers");
  await user.click(screen.getByRole("button", { name: "Add timer" }));
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "watch/timer": expect.objectContaining({
        type: "timer",
        interest_id: "release-triage",
        prompt: "Summarise blockers",
        interval_secs: 3600,
      }),
    },
  });
});
