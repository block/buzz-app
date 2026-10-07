// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import * as communityApi from "../../features/communities/api";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { OutgoingEvent } from "../../features/relay/outbox";
import { agentDraft, agentEdit } from "../agents/agent-edit";
import { createLocalBestie, readSetup, type BestieSetup } from "./setup";

const owner = "cd".repeat(32);
const origin = "https://relay.example.test";
const scope = `${origin}:${owner}`;
const active: ReturnType<typeof createLocalBestie>[] = [];

afterEach(async () => {
  try {
    for (const bestie of active.splice(0)) await bestie.dispose();
  } finally {
    vi.restoreAllMocks();
    localStorage.clear();
  }
});

function close(bestie: ReturnType<typeof createLocalBestie>) {
  const index = active.indexOf(bestie);
  if (index >= 0) active.splice(index, 1);
  return bestie.dispose();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Native controls are real; relay methods expose only the captured service boundary. */
function fixture() {
  const native = controlFixture();
  native.data.agents = [];
  native.data.createAvailable = true;
  native.data.defaultWorkspace = "/fixture/workspace";
  Object.assign(native.agent, {
    enabled: false,
    status: "stopped",
    runningRevision: null,
    startOnAppLaunch: false,
    profilePending: true,
  });
  native.host.prepareCreate = vi.fn(async () => ({
    id: native.agent.id,
    pubkey: native.agent.pubkey,
  }));
  native.host.commitCreate = vi.fn(async (_request, edit) => {
    const saved = readSetup(scope, owner, origin);
    expect(saved.agent).toEqual({
      id: native.agent.id,
      pubkey: native.agent.pubkey,
    });
    Object.assign(native.agent, {
      name: edit.name,
      systemPrompt: edit.systemPrompt,
      workspace: edit.workspace,
      sessionPolicy: edit.sessionPolicy,
      harness: {
        ...edit.harness,
        environmentKeys: Object.keys(edit.environment),
      },
    });
    native.data.agents.push(native.agent);
    return structuredClone(native.data);
  });
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({
    auth: ["fixture-owner-attestation"],
  });
  const control = createAgentControl(native.host);
  const channels = new Map<string, ChannelSummary>();
  const channelListeners = new Set<() => void>();
  const outbox: OutgoingEvent[] = [];
  let eventSequence = 0;
  const eventId = () => (++eventSequence).toString(16).padStart(64, "0");
  const createSession = (id: string, name: string) => {
    const operation = eventId();
    outbox.push({
      event: {
        id: operation,
        pubkey: owner,
        kind: 9007,
        created_at: 100,
        content: name,
        tags: [["h", id]],
      },
      delivery: "accepted",
    });
    channels.set(id, {
      id,
      name,
      channelType: "session",
      visibility: "private",
      members: [owner],
    });
    return operation;
  };
  const workSessions = {
    create: vi.fn((id: string, name: string) => createSession(id, name)),
    delivered: vi.fn(async (id: string) => {
      if (!outbox.some((item) => item.event.id === id))
        throw new Error("Unknown operation receipt");
    }),
    refresh: vi.fn(async (id: string) => {
      if (!channels.has(id)) throw new Error("Missing signed channel");
    }),
    addAgents: vi.fn(async (id: string, keys: string[]) => {
      const channel = channels.get(id);
      if (!channel?.members) throw new Error("Missing signed roster");
      channels.set(id, {
        ...channel,
        members: [...new Set([...channel.members, ...keys])],
      });
    }),
  };
  const session = {
    viewer: owner,
    profiles: { ensure: vi.fn() },
    channels: {
      ensureList: vi.fn(),
      list: () => ({ status: "ready", channels: [...channels.values()] }),
      subscribeList: (listener: () => void) => {
        channelListeners.add(listener);
        return () => channelListeners.delete(listener);
      },
    },
    outbox: { ready: async () => {}, snapshot: () => outbox },
    workSessions,
  } as unknown as RelaySession;
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope,
    viewer: owner,
    session,
  };
  const relayListeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe: (listener) => {
      relayListeners.add(listener);
      return () => relayListeners.delete(listener);
    },
    retry: () => {},
    disconnect: () => {},
    clearCache: async () => {},
  };
  const open = (agentControl = control) => {
    const bestie = createLocalBestie(relay, agentControl);
    active.push(bestie);
    return bestie;
  };
  return {
    native,
    control,
    channels,
    workSessions,
    session,
    open,
    record: () => readSetup(scope, owner, origin),
    changeConnection(next: RelaySnapshot) {
      connection = next;
      for (const listener of relayListeners) listener();
    },
    changeRoster(id: string, members: string[]) {
      const channel = channels.get(id);
      if (!channel) throw new Error("Missing channel");
      channels.set(id, { ...channel, members });
      for (const listener of channelListeners) listener();
    },
  };
}

async function ready(bestie: ReturnType<typeof createLocalBestie>) {
  await vi.waitFor(() => expect(bestie.snapshot().status).toBe("ready"));
  return bestie.snapshot().record as BestieSetup;
}

it("creates one attested local agent and its private Bestie session", async () => {
  const f = fixture();
  const record = await ready(f.open());
  expect(f.native.host.prepareCreate).toHaveBeenCalledExactlyOnceWith(
    record.request,
    origin,
    owner,
  );
  expect(communityApi.communityRequest).toHaveBeenCalledExactlyOnceWith(
    origin,
    "authorize-agent",
    { pubkey: f.native.agent.pubkey, owner },
  );
  expect(f.native.host.commitCreate).toHaveBeenCalledTimes(1);
  const commit = f.native.host.commitCreate;
  if (!commit) throw new Error("Missing native creation capability");
  expect(vi.mocked(commit).mock.calls[0]?.[1].environment).toEqual({
    BUZZ_ACP_AGENTS: "1",
    BUZZ_ACP_CHANNELS: record.home.id,
  });
  expect(f.native.agent).toMatchObject({
    name: "Local Bestie",
    enabled: true,
    status: "running",
    profilePending: false,
    startOnAppLaunch: false,
  });
  expect(f.native.agent.systemPrompt).toContain(record.home.id);
  expect(f.native.agent.harness.environmentKeys).toEqual(
    expect.arrayContaining(["BUZZ_ACP_AGENTS", "BUZZ_ACP_CHANNELS"]),
  );
  expect(f.workSessions.create).toHaveBeenCalledExactlyOnceWith(
    record.home.id,
    "Bestie",
  );
  expect([...f.channels.values()]).toEqual([
    expect.objectContaining({
      id: record.home.id,
      channelType: "session",
      visibility: "private",
      members: [owner, f.native.agent.pubkey],
    }),
  ]);
});

it("reports the native read failure rather than claiming the runtime is missing", async () => {
  const f = fixture();
  vi.spyOn(f.native.host, "snapshot").mockRejectedValue(
    "Invalid or host-reserved environment key",
  );
  const bestie = f.open();
  await vi.waitFor(() => expect(bestie.snapshot().status).toBe("error"));
  expect(bestie.snapshot().message).toContain(
    "Invalid or host-reserved environment key",
  );
  expect(f.native.host.prepareCreate).not.toHaveBeenCalled();
});

it("retry immediately shows progress while native refresh is pending and reuses reserved IDs", async () => {
  const f = fixture();
  const snapshot = vi
    .spyOn(f.native.host, "snapshot")
    .mockRejectedValueOnce("Native read failed");
  const bestie = f.open();
  await vi.waitFor(() => expect(bestie.snapshot().status).toBe("error"));
  const reserved = f.record();
  const started = deferred();
  const release = deferred();
  snapshot.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return structuredClone(f.native.data);
  });
  try {
    bestie.retry();
    expect(bestie.snapshot().status).toBe("setting-up");
    await started.promise;
    expect(f.native.host.prepareCreate).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  const record = await ready(bestie);
  expect(record.request).toBe(reserved.request);
  expect(record.home.id).toBe(reserved.home.id);
});

it("disabling stops the runner, then re-enable reuses the same identities", async () => {
  const f = fixture();
  const first = f.open();
  const record = await ready(first);
  const ids = {
    agent: record.agent?.id,
    home: record.home.id,
  };
  await close(first);
  expect(f.native.agent).toMatchObject({ enabled: false, status: "stopped" });
  const reopened = await ready(f.open(createAgentControl(f.native.host)));
  expect({
    agent: reopened.agent?.id,
    home: reopened.home.id,
  }).toEqual(ids);
  expect(f.native.host.commitCreate).toHaveBeenCalledTimes(1);
  expect(f.workSessions.create).toHaveBeenCalledTimes(1);
  expect(f.native.agent).toMatchObject({ enabled: true, status: "running" });
});

it("recovers an exact prepared identity after the native commit result was lost", async () => {
  const f = fixture();
  const commit = f.native.host.commitCreate;
  if (!commit) throw new Error("Missing native creation capability");
  f.native.host.commitCreate = vi.fn<typeof commit>(async (...args) => {
    await commit(...args);
    throw new Error("Native commit reply was lost");
  });
  const first = f.open();
  await vi.waitFor(() => expect(first.snapshot().status).toBe("error"));
  expect(f.record().agent).toEqual({
    id: f.native.agent.id,
    pubkey: f.native.agent.pubkey,
  });
  expect(f.channels.size).toBe(0);
  await close(first);
  const restartedControl = createAgentControl(f.native.host);
  await ready(f.open(restartedControl));
  expect(f.native.host.prepareCreate).toHaveBeenCalledTimes(1);
  expect(f.native.host.commitCreate).toHaveBeenCalledTimes(1);
  expect(f.record().agent?.committed).toBe(true);
  expect(f.native.data.agents).toHaveLength(1);
});

it.each(["getItem", "setItem"] as const)(
  "creates no resources when setup storage %s fails",
  async (method) => {
    const f = fixture();
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const bestie = f.open();
    await vi.waitFor(() => expect(bestie.snapshot().status).toBe("error"));
    expect(f.native.calls).toEqual([]);
    expect(f.native.host.prepareCreate).not.toHaveBeenCalled();
    expect(f.channels.size).toBe(0);
  },
);

it("does not replace a missing saved identity with another agent named Local Bestie", async () => {
  const f = fixture();
  const first = f.open();
  await ready(first);
  await close(first);
  f.native.data.agents = [
    {
      ...structuredClone(f.native.agent),
      id: "another-local-bestie",
      pubkey: "ef".repeat(32),
    },
  ];
  const restarted = f.open(createAgentControl(f.native.host));
  await vi.waitFor(() => expect(restarted.snapshot().status).toBe("error"));
  expect(restarted.snapshot().message).toContain(
    "saved local Bestie is missing",
  );
  expect(f.native.host.commitCreate).toHaveBeenCalledTimes(1);
  expect(f.workSessions.create).toHaveBeenCalledTimes(1);
  expect(f.native.data.agents[0]?.enabled).toBe(false);
});

it("stops the local runner when its private roster expands", async () => {
  const f = fixture();
  const bestie = f.open();
  const record = await ready(bestie);
  f.changeRoster(record.home.id, [
    owner,
    f.native.agent.pubkey,
    "ef".repeat(32),
  ]);
  expect(bestie.snapshot().status).toBe("error");
  await vi.waitFor(() =>
    expect(f.native.agent).toMatchObject({ enabled: false, status: "stopped" }),
  );
});

it("rejects an unconfirmed native Stop and blocks restart until Stop is confirmed", async () => {
  const f = fixture();
  const first = f.open();
  await ready(first);
  const action = f.native.host.action;
  const nativeAction = vi
    .spyOn(f.native.host, "action")
    .mockImplementation(async (id, command, replayFloor) => {
      if (command === "stop") {
        Object.assign(f.native.agent, { enabled: false, status: "failed" });
        return structuredClone(f.native.data);
      }
      return action(id, command, replayFloor);
    });
  try {
    await expect(close(first)).rejects.toThrow("Stop is unconfirmed");
    const reopened = f.open(createAgentControl(f.native.host));
    await vi.waitFor(() => expect(reopened.snapshot().status).toBe("error"));
    expect(reopened.snapshot().message).toContain("Stop is unconfirmed");
    expect(
      f.native.calls.filter((call) => call.action === "start"),
    ).toHaveLength(1);
    nativeAction.mockRestore();
    reopened.retry();
    await ready(reopened);
    expect(f.native.agent).toMatchObject({ enabled: true, status: "running" });
    expect(
      f.native.calls.filter((call) => call.action === "start"),
    ).toHaveLength(2);
  } finally {
    nativeAction.mockRestore();
  }
});

it("surfaces a roster-change Stop failure even when the native call resolves", async () => {
  const f = fixture();
  const bestie = f.open();
  const record = await ready(bestie);
  const action = f.native.host.action;
  const nativeAction = vi
    .spyOn(f.native.host, "action")
    .mockImplementation(async (id, command, replayFloor) => {
      if (command === "stop") {
        Object.assign(f.native.agent, { enabled: false, status: "failed" });
        return structuredClone(f.native.data);
      }
      return action(id, command, replayFloor);
    });
  try {
    f.changeRoster(record.home.id, [
      owner,
      f.native.agent.pubkey,
      "ef".repeat(32),
    ]);
    await vi.waitFor(() =>
      expect(bestie.snapshot().message).toContain("Stop is unconfirmed"),
    );
    expect(bestie.snapshot().status).toBe("error");
    expect(f.native.agent.status).toBe("failed");
  } finally {
    nativeAction.mockRestore();
  }
});

it("retains a failed Stop for the previous community across a retry in another community", async () => {
  const f = fixture();
  const bestie = f.open();
  const record = await ready(bestie);
  const action = f.native.host.action;
  const nativeAction = vi
    .spyOn(f.native.host, "action")
    .mockImplementation(async (id, command, replayFloor) => {
      if (command === "stop") {
        Object.assign(f.native.agent, { enabled: false, status: "failed" });
        return structuredClone(f.native.data);
      }
      return action(id, command, replayFloor);
    });
  let unwatch = () => {};
  try {
    const otherScope = `https://other-relay.example.test:${owner}`;
    f.changeConnection({
      status: "ready",
      generation: 2,
      scope: otherScope,
      viewer: owner,
      session: { ...f.session },
    });
    await vi.waitFor(() => expect(bestie.snapshot().status).toBe("error"));
    expect(bestie.snapshot().connection?.scope).toBe(otherScope);
    expect(bestie.snapshot().record).toBeUndefined();
    expect(bestie.snapshot().message).toContain("Stop is unconfirmed");
    const previousCalls = nativeAction.mock.calls.length;
    let retryErrors = 0;
    unwatch = bestie.subscribe(() => {
      if (bestie.snapshot().status === "error") retryErrors++;
    });
    bestie.retry();
    await vi.waitFor(() => expect(retryErrors).toBe(1));
    expect(nativeAction.mock.calls.slice(previousCalls)).toEqual([
      [record.agent?.id, "stop"],
    ]);
    expect(f.native.host.prepareCreate).toHaveBeenCalledTimes(1);
    expect(
      f.native.calls.filter((call) => call.action === "start"),
    ).toHaveLength(1);
    expect(f.workSessions.create).toHaveBeenCalledTimes(1);
  } finally {
    unwatch();
    nativeAction.mockRestore();
  }
});

it("preserves owner-edited instructions on retry", async () => {
  const f = fixture();
  const bestie = f.open();
  await ready(bestie);
  await f.control.save(
    f.native.agent.id,
    f.native.agent.revision,
    agentEdit({
      ...agentDraft(f.native.agent),
      systemPrompt: "Owner's instructions",
    }),
  );
  bestie.retry();
  await vi.waitFor(() =>
    expect(
      f.native.calls.filter((call) => call.action === "start"),
    ).toHaveLength(2),
  );
  await ready(bestie);
  expect(f.native.agent.systemPrompt).toBe("Owner's instructions");
});

it("disabling stops before a pending launch reply and ignores its late running snapshot", async () => {
  const f = fixture();
  const launchStarted = deferred();
  const releaseLaunch = deferred();
  const action = f.native.host.action;
  const nativeAction = vi
    .spyOn(f.native.host, "action")
    .mockImplementation(async (id, command, replayFloor) => {
      const result = await action(id, command, replayFloor);
      if (command === "start") {
        launchStarted.resolve();
        await releaseLaunch.promise;
      }
      return result;
    });
  const bestie = f.open();
  await launchStarted.promise;
  expect(f.control.snapshot().pendingLaunch).toBe(f.native.agent.id);
  expect(f.control.snapshot().data?.agents[0]?.status).toBe("stopped");
  const disposing = close(bestie);
  try {
    await vi.waitFor(() =>
      expect(nativeAction).toHaveBeenCalledWith(f.native.agent.id, "stop"),
    );
  } finally {
    releaseLaunch.resolve();
    await disposing;
  }
  expect(f.native.agent).toMatchObject({ enabled: false, status: "stopped" });
  expect(f.control.snapshot().data?.agents[0]?.status).toBe("stopped");
});
