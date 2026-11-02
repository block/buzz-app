// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ExternalConnectionSettings } from "./ExternalConnectionSettings";
import { createExternalConnection } from "../../features/agents/external-connection";
import type { Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import type { HostMcpServer } from "../../features/host/service";

afterEach(cleanup);

it.each([false, true])(
  "shows the granted agent when settings open again (starting: %s)",
  async (starting) => {
    const pubkey = "a".repeat(64);
    const inventory = {
      agents: [{ key: pubkey, pubkey, name: "Test agent", place: "here" }],
    };
    const choices = {
      selectable: [{ pubkey }],
      pending: false,
      archives: { status: "ready" },
    };
    const subscribe = () => () => {};
    const state = {
      status: "ready",
      session: { agentChoices: { subscribe, snapshot: () => choices } },
    };
    let finish!: (server: HostMcpServer) => void;
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const server = {
      url: "http://127.0.0.1:1234/mcp",
      headers: [],
      closed,
      close: async () => stopped(),
    };
    const agents = {
      subscribe,
      snapshot: () => inventory,
      connectExternal: async (_key: string, lifetime: AbortSignal) => {
        signal = lifetime;
        started();
        return starting
          ? new Promise<HostMcpServer>((resolve) => {
              finish = resolve;
            })
          : server;
      },
    } as unknown as Agents;
    const connection = createExternalConnection(agents);
    const creating = connection.create(pubkey);
    await began;
    if (!starting) await creating;
    const view = () => (
      <ExternalConnectionSettings
        agents={agents}
        relay={{ subscribe, snapshot: () => state } as unknown as RelayData}
        connection={connection}
      />
    );
    const first = render(view());
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
      "Test agent",
    );
    first.unmount();
    render(view());
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
      "Test agent",
    );
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Revoke access" }));
      expect(signal?.aborted).toBe(true);
      expect(screen.getByRole("status")).toHaveTextContent(
        "No external connection.",
      );
    } finally {
      if (starting) finish(server);
    }
    await creating;
  },
);
