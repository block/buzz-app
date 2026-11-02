// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalAuthorizationDialog } from "./ExternalAuthorizationDialog";
import { createExternalApps } from "./external-connection";
import type { Agents } from "./service";
import type { Communities } from "../communities/service";
import type { RelayData } from "../relay/service";

afterEach(cleanup);
it.each(["Authorize", "Deny"])(
  "requires the owner to choose %s before it sends a result",
  async (action) => {
    const key = "a".repeat(64),
      viewer = "b".repeat(64),
      origin = "https://fixture.example.test";
    const subscribe = () => () => {};
    const choices = {
      selectable: [{ pubkey: key }],
      pending: false,
      archives: { status: "ready" },
    };
    const transport = {
      status: "ready",
      scope: origin,
      session: { agentChoices: { subscribe, snapshot: () => choices } },
    };
    const client = {
      viewer,
      selected: origin,
      memberships: [{ id: origin, name: "Test community" }],
    };
    const inventory = {
      agents: [{ key, pubkey: key, name: "Test agent", place: "here" }],
    };
    let stop!: () => void;
    const closed = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const authorize = vi.fn(async () => {}),
      deny = vi.fn(async () => {});
    const connect = vi.fn(async () => ({
      url: "http://127.0.0.1:1234/mcp",
      headers: [],
      closed,
      close: async () => stop(),
      authorize,
    }));
    const connection = createExternalApps();
    const release = connection.bind({ connect, deny });
    connection.open(
      {
        version: 1,
        client: "Test app",
        callback: "http://127.0.0.1:1234/buzz/authorize",
        state: "A".repeat(43),
        scope: ["read", "post"],
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
      },
      viewer,
    );
    render(
      <ExternalAuthorizationDialog
        connection={connection}
        agents={{ subscribe, snapshot: () => inventory } as unknown as Agents}
        communities={
          {
            subscribe,
            snapshot: () => client,
            select: () => {},
          } as unknown as Communities
        }
        relay={{ subscribe, snapshot: () => transport } as unknown as RelayData}
      />,
    );
    expect(
      await screen.findByRole("dialog", { name: "Authorize external app" }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
      "Test agent",
    );
    expect(connect).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: action }));
    if (action === "Authorize") {
      await waitFor(() => expect(authorize).toHaveBeenCalledOnce());
      expect(connect).toHaveBeenCalledWith(
        key,
        expect.any(AbortSignal),
        expect.any(Function),
        ["read", "post"],
      );
    } else {
      await waitFor(() => expect(deny).toHaveBeenCalledOnce());
      expect(connect).not.toHaveBeenCalled();
    }
    cleanup();
    release();
  },
);
