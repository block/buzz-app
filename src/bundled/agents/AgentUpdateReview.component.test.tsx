// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  let rosterGate = gate;
  let omitRoster = false;
  let failRoster = false;
  const readRoster = vi.fn(async () => {
    await rosterGate;
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
  const send = (changes: { displayName?: string } = {}) =>
    act(() =>
      receive(fixture.agent.pubkey, {
        type: "agent_management_request",
        action: "update",
        requestId: "review",
        request: {
          channelId: channel.id,
          agentName: fixture.agent.name,
          model: "gpt-6-sol",
          ...changes,
        },
      }),
    );
  return {
    fixture,
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
    setListStatus: (status: ChannelList["status"]) => {
      list = { ...list, status };
      for (const listener of listeners) listener();
    },
    holdRoster: () => {
      let resume!: () => void;
      rosterGate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return resume;
    },
    revoke: () => {
      channel.members = [];
    },
    recover: () => {
      failInventory = false;
    },
  };
}

it("preserves owner edits while blocking writes during membership revalidation", async () => {
  const f = setup(true);
  f.send();
  await act(async () => f.release());
  const editor = await screen.findByRole("dialog", { name: "Edit agent" });
  const model = screen.getByRole("combobox", { name: "Model" });
  await userEvent.clear(model);
  await userEvent.type(model, "owner-model");
  await userEvent.click(
    screen.getByRole("option", { name: /owner-model.*Custom ID/ }),
  );
  const resume = f.holdRoster();
  try {
    await act(async () => f.setListStatus("error"));
    expect(editor).toBeVisible();
    expect(model).toHaveValue("owner-model");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const form = editor.querySelector("form");
    if (!form) throw Error("Missing review form");
    fireEvent.submit(form);
    expect(f.fixture.calls.filter(({ action }) => action === "save")).toEqual(
      [],
    );
    await act(async () => f.setListStatus("ready"));
    await waitFor(() => expect(f.readRoster).toHaveBeenCalledTimes(2));
    expect(editor).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  } finally {
    await act(async () => resume());
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled(),
  );
  expect(model).toHaveValue("owner-model");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull(),
  );
  expect(f.fixture.agent.harness.model).toBe("owner-model");
});

it("keeps the selected agent editor after a rename reports restart failure", async () => {
  const f = setup(true);
  const save = f.fixture.host.save;
  f.fixture.host.save = async (...args) => ({
    ...(await save(...args)),
    restarted: 0,
    restartFailures: 1,
  });
  f.send({ displayName: "Renamed fixture agent" });
  await act(async () => f.release());
  const editor = await screen.findByRole("dialog", { name: "Edit agent" });
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(f.control.snapshot().busy).toBe(false));
  expect(editor).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Renamed fixture agent",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 agent couldn’t restart with the new settings; check Agents.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Runtime" }));
  expect(
    screen.getByRole("button", { name: "Restart to apply" }),
  ).toBeEnabled();
  expect(screen.queryByText(/No personal agent named/)).toBeNull();
  f.failRoster(true);
  await act(async () => f.setListStatus("error"));
  expect(editor).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 agent couldn’t restart with the new settings; check Agents.",
  );
  expect(
    screen.getByRole("button", { name: "Restart to apply" }),
  ).toBeDisabled();
  await act(async () => f.setListStatus("ready"));
  const retry = await screen.findByRole("button", { name: "Retry" });
  f.failRoster(false);
  await userEvent.click(retry);
  expect(editor).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Renamed fixture agent",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Restart to apply" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 agent couldn’t restart with the new settings; check Agents.",
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

it("completes an in-flight Save while membership is temporarily unknown", async () => {
  const f = setup(true);
  const save = f.fixture.host.save;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.fixture.host.save = async (...args) => {
    await gate;
    return save(...args);
  };
  f.send();
  await act(async () => f.release());
  const editor = await screen.findByRole("dialog", { name: "Edit agent" });
  try {
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(f.control.snapshot().busy).toBe(true));
    await act(async () => f.setListStatus("error"));
    expect(editor).toBeVisible();
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(f.control.snapshot().busy).toBe(false));
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
  await act(async () => f.setListStatus("ready"));
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
  expect(
    f.fixture.calls.filter(({ action }) => action === "save"),
  ).toHaveLength(1);
});

it("dismisses an active review when membership is definitely revoked", async () => {
  const f = setup(true);
  f.send();
  await act(async () => f.release());
  await screen.findByRole("dialog", { name: "Edit agent" });
  await act(async () => {
    f.revoke();
    f.setListStatus("ready");
  });
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
  expect(f.fixture.calls.filter(({ action }) => action === "save")).toEqual([]);
});

it("waits for a busy operation before refreshing inventory for a request", async () => {
  const f = setup(true);
  await act(async () => {
    await f.control.refresh();
  });
  const snapshot = vi.spyOn(f.fixture.host, "snapshot");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = f.fixture.host.action;
  f.fixture.host.action = async (...args) => {
    await gate;
    return action(...args);
  };
  let pending!: Promise<unknown>;
  act(() => {
    pending = f.control.action(f.fixture.agent.id, "stop");
  });
  try {
    expect(f.control.snapshot().busy).toBe(true);
    f.send();
    await act(async () => f.release());
    expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release();
      await pending;
    });
  }
  expect(
    await screen.findByRole("dialog", { name: "Edit agent" }),
  ).toBeVisible();
  expect(snapshot).toHaveBeenCalledOnce();
});

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
