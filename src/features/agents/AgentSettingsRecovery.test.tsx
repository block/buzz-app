// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSettingsRecovery } from "./AgentSettingsRecovery";
import { artifactTemplate } from "./agent-config-artifacts";
import type { Agents, ConfigHistory } from "./service";
import type { RelayEvent } from "../relay/events";
afterEach(cleanup);

it.each(["refused", "uncertain", "throw"] as const)(
  "keeps the repair open and reports a %s write",
  async (status) => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const head = {
      ...artifactTemplate({
        channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
        d: "settings",
        type: "buzz.agent.settings",
        op: "create",
        title: "Settings",
        content: JSON.stringify({
          version: 1,
          settings: { voice: "maple", model: "keep" },
        }),
      }),
      id: "opened",
      pubkey: "",
      sig: "",
    } as RelayEvent;
    const revise = vi.fn(async () => {
      await pending;
      if (status === "throw") throw new Error("Connection failed");
      return { status, message: "Not confirmed" };
    });
    const history = {
      sides: [
        {
          side: "settings",
          expected: {
            channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
            d: "settings",
            type: "buzz.agent.settings",
          },
          head,
          version: 1,
        },
      ],
      settings: { agentType: "test/echo", schema: { model: "string" } },
      revise,
      read: async () => [],
    } as ConfigHistory;
    render(
      <AgentSettingsRecovery
        agentKey="agent"
        agents={
          { configHistory: () => history } as Pick<Agents, "configHistory">
        }
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Repair settings" }));
    await user.click(
      screen.getByRole("button", { name: "Save repaired settings" }),
    );
    try {
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(
        screen.getByRole("dialog", { name: "Repair settings" }),
      ).toBeVisible();
      expect(revise).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => finish());
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      status === "throw" ? "Connection failed" : "Not confirmed",
    );
    expect(
      screen.getByRole("dialog", { name: "Repair settings" }),
    ).toBeVisible();
    expect(JSON.parse(head.content).settings).toEqual({
      voice: "maple",
      model: "keep",
    });
  },
);
