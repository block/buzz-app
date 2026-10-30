// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as React from "react";
import {
  createAgentControl,
  type BrowserAgentHost,
} from "../../../examples/plugins/browser-control/src/AgentControl";
import { browserToolbarUi } from "./toolbar-ui";
const BrowserAgentControl = createAgentControl(React, browserToolbarUi);
import { BrowserAccess } from "./control-access";
import type { BrowserControl } from "./platform";

afterEach(cleanup);
function fixture(local = true) {
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const candidate = { pubkey: "agent", name: "Tester" };
  const choices = {
    selectable: [candidate],
    complete: true,
    pending: false,
    archives: { status: "ready" },
  };
  const channels = {
    channels: [{ id: "chat", channelType: "solo", members: ["agent"] }],
  };
  let state = {
    running: local
      ? [{ key: "agent", pubkey: "agent", place: "here", owner: "owner" }]
      : [],
  };
  const connection = {
    status: "ready",
    scope: "community:owner",
    viewer: "owner",
    session: {
      agentChoices: {
        snapshot: () => choices,
        subscribe,
        retain: () => () => {},
        ensure: vi.fn(),
      },
      channels: {
        list: () => channels,
        subscribeList: subscribe,
        ensureList: vi.fn(),
      },
    },
  };
  const native: BrowserControl = {
    available: async () => true,
    grant: vi.fn(async () => ({ token: "never-display-this", revision: 1 })),
    revoke: vi.fn(async () => {}),
    execute: vi.fn(async () => "page"),
  };
  const access = new BrowserAccess(native, () => state.running.length > 0);
  const host = {
    access,
    relay: { snapshot: () => connection, subscribe },
    agents: {
      snapshot: () => state,
      subscribe,
      relay: () => ({ snapshot: () => connection }),
    },
  } as unknown as BrowserAgentHost;
  return {
    host,
    access,
    native,
    stop() {
      state = { running: [] };
      for (const fn of listeners) fn();
    },
  };
}
const status = {
  url: "https://example.com",
  title: "Example",
  loading: false,
  error: null,
};

it("shares with the only conversation agent without exposing a token, then revokes on stop", async () => {
  const f = fixture();
  render(
    <BrowserAgentControl
      host={f.host}
      conversation={{ channel: "chat" }}
      sessionId="view"
      status={status}
      prepare={async () => {}}
      onError={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Share/ }));
  expect(screen.getByRole("status")).toHaveTextContent("Tester");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByText("never-display-this")).not.toBeInTheDocument();
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "message", topLevel: true },
      { action: "observe" },
    ),
  ).resolves.toBe("page");
  await act(async () => {
    f.stop();
  });
  expect(screen.getByRole("button", { name: /^Share/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    f.access.execute("agent", { channel: "chat" }, { action: "observe" }),
  ).rejects.toThrow("No browser");
});

it("explains why a conversation agent hosted elsewhere cannot use the browser", () => {
  const f = fixture(false);
  render(
    <BrowserAgentControl
      host={f.host}
      conversation={{ channel: "chat" }}
      sessionId="view"
      status={status}
      prepare={async () => {}}
      onError={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Share browser" })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Share/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(f.native.grant).not.toHaveBeenCalled();
});

it("forgets a hidden browser's grant before another view is shared", async () => {
  const f = fixture();
  const view = render(
    <BrowserAgentControl
      host={f.host}
      conversation={{ channel: "chat" }}
      sessionId="first"
      status={status}
      prepare={async () => {}}
      onError={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Share/ }));
  view.rerender(
    <BrowserAgentControl
      host={f.host}
      conversation={{ channel: "chat" }}
      sessionId="first"
      status={{ ...status, control_revision: 2, control_granted: false }}
      prepare={async () => {}}
      onError={() => {}}
    />,
  );
  await f.access
    .forRecipient({ agent: "agent", channel: "chat", scope: "community:owner" })
    .grant("second");
  await expect(
    f.access.execute("agent", { channel: "chat" }, { action: "observe" }),
  ).resolves.toBe("page");
});
