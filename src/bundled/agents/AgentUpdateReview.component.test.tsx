// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { ChannelList } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentUpdateReview } from "./AgentUpdateReview";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(known: boolean, failInventory = false) {
  const fixture = controlFixture();
  const channel = {
    id: "project",
    name: "Project",
    members: [fixture.agent.pubkey],
  };
  let list: ChannelList = {
    status: "ready",
    coverage: "partial",
    channels: known ? [channel] : [],
  };
  const listeners = new Set<() => void>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let omitRoster = false;
  let failRoster = false;
  const readRoster = vi.fn(async () => {
    await gate;
    if (failRoster) throw Error("Relay unavailable");
    if (omitRoster) return false;
    list = { ...list, channels: [channel] };
    for (const listener of listeners) listener();
    return true;
  });
  const owner = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: fixture.agent.relayUrl,
    query: async () => [],
    media: () => undefined,
  });
  disposals.push(() => owner.dispose());
  let receive!: Parameters<RelaySession["agentManagement"]["subscribe"]>[0];
  const session: RelaySession = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => list,
      subscribeList: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      resolve: async () => {
        await readRoster();
      },
      refreshRoster: readRoster,
    },
    agentManagement: {
      ...owner.session.agentManagement,
      activate: () => () => {},
      subscribe: (listener) => {
        receive = listener;
        return () => {};
      },
    },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `${fixture.agent.relayUrl}:${"de".repeat(32)}`,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const hostRead = fixture.host.snapshot;
  fixture.host.snapshot = async () => {
    if (failInventory) throw Error("Inventory unavailable");
    return hostRead();
  };
  const control = createAgentControl(fixture.host);
  disposals.push(() => control.dispose());
  render(<AgentUpdateReview relay={relay} control={control} />, {
    wrapper: ToastProvider,
  });
  const send = () =>
    act(() =>
      receive(fixture.agent.pubkey, {
        type: "agent_management_request",
        action: "update",
        requestId: "review",
        request: {
          channelId: channel.id,
          agentName: fixture.agent.name,
          model: "gpt-6-sol",
        },
      }),
    );
  return {
    send,
    release,
    readRoster,
    control,
    omit: () => {
      omitRoster = true;
    },
    failRoster: (failed: boolean) => {
      failRoster = failed;
    },
    revoke: () => {
      channel.members = [];
    },
    recover: () => {
      failInventory = false;
    },
  };
}

for (const known of [false, true]) {
  it(`waits for confirmed membership with a ${known ? "cached" : "missing"} roster`, async () => {
    const fixture = setup(known);
    try {
      fixture.send();
      await act(async () => {
        await fixture.control.refresh();
      });
      await waitFor(() => expect(fixture.readRoster).toHaveBeenCalledOnce());
      expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
    } finally {
      await act(async () => fixture.release());
    }
    expect(
      await screen.findByRole("dialog", { name: "Edit agent" }),
    ).toBeVisible();
  });
}

it("opens the pending review after a successful manual inventory retry", async () => {
  const fixture = setup(false, true);
  fixture.send();
  await act(async () => fixture.release());
  const retry = await screen.findByRole("button", {
    name: "Retry",
  });
  fixture.recover();
  await userEvent.click(retry);
  expect(
    await screen.findByRole("dialog", { name: "Edit agent" }),
  ).toBeVisible();
});

it("rejects a request whose refreshed roster no longer includes its sender", async () => {
  const fixture = setup(true);
  try {
    fixture.send();
    await waitFor(() => expect(fixture.readRoster).toHaveBeenCalledOnce());
    fixture.revoke();
  } finally {
    await act(async () => fixture.release());
  }
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
});

it("does not authorize stale membership after an empty roster read", async () => {
  const fixture = setup(true);
  fixture.omit();
  fixture.send();
  await act(async () => fixture.release());
  await act(async () => {
    await fixture.control.refresh();
  });
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
});

it("retains a request through a failed roster read and retries it", async () => {
  const fixture = setup(true);
  fixture.failRoster(true);
  fixture.send();
  await act(async () => fixture.release());
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
  fixture.failRoster(false);
  await userEvent.click(retry);
  expect(
    await screen.findByRole("dialog", { name: "Edit agent" }),
  ).toBeVisible();
  expect(fixture.readRoster).toHaveBeenCalledTimes(2);
});
