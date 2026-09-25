// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentControl,
  type AgentControlHost,
  type ControlSnapshot,
} from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { profileTarget } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";

const viewer = "f".repeat(64);
const agentKey = "ab".repeat(32);
const home = `https://relay.example.test:${viewer}`;
const elsewhere = `https://other.example.test:${viewer}`;
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

function relayAt(scope: string, knownAgent = false) {
  const owner = createRelaySession(null);
  owners.push(owner);
  const listeners = new Set<() => void>();
  // Signed agent metadata makes ProfileInstances a second native reader.
  const profiles = new Map([
    [agentKey, { name: "Fixture agent", isAgent: true }],
  ]);
  const session = knownAgent
    ? ({
        ...owner.session,
        profiles: { ...owner.session.profiles, snapshot: () => profiles },
      } as RelaySnapshot["session"])
    : owner.session;
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope,
    viewer,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  return {
    relay,
    move(next: string) {
      snapshot = {
        ...snapshot,
        scope: next,
        generation: snapshot.generation + 1,
      };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

/** Each read is held until the test settles it. */
function heldHost(fixture = controlFixture()) {
  const reads: {
    resolve(data: ControlSnapshot): void;
    reject(error: unknown): void;
  }[] = [];
  const host: AgentControlHost = {
    ...fixture.host,
    snapshot: () =>
      new Promise((resolve, reject) => reads.push({ resolve, reject })),
  };
  const control = createAgentControl(host);
  owners.push(control);
  /** Observe that read `index` started, then settle it inside act. */
  const settle = async (index: number, outcome: ControlSnapshot | string) => {
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(index));
    await act(async () => {
      const read = reads[index];
      if (typeof outcome === "string") read?.reject(outcome);
      else read?.resolve(structuredClone(outcome));
    });
  };
  return { control, reads, settle, data: fixture.data, agent: fixture.agent };
}

function mount(
  control: ReturnType<typeof createAgentControl>,
  relay: RelayData,
  pubkey = agentKey,
) {
  return render(
    <StrictMode>
      <ProfilePanel
        relay={relay}
        control={control}
        target={profileTarget(pubkey) ?? ""}
        close={() => {}}
      />
    </StrictMode>,
  );
}

it("keeps browser and unavailable-host profiles public, without an owner view", async () => {
  const control = createAgentControl(null);
  owners.push(control);
  mount(control, relayAt(home).relay);
  await screen.findByRole("region", { name: "Profile details" });
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
  expect(
    screen.getByRole("heading", { level: 3, name: "Public key" }),
  ).toBeVisible();
});

it("summarizes only the exact key in the active community, and drops it when the scope moves", async () => {
  const { control, settle, data, agent } = heldHost();
  Object.assign(agent, {
    relayUrl: "wss://relay.example.test",
    revision: 3,
    runningRevision: 2,
    error: "Last start exited early.",
    diagnostics: ["spawned pid 42", "listener exited"],
  });
  data.agents.push(
    {
      ...structuredClone(agent),
      id: "foreign",
      relayUrl: "wss://other.example.test",
      name: "Foreign copy",
      status: "stopped",
      runningRevision: null,
    },
    { ...structuredClone(agent), id: "namesake", pubkey: "cd".repeat(32) },
  );
  const community = relayAt(home);
  mount(control, community.relay);
  await settle(0, data);
  const summary = await screen.findByRole("region", { name: "Local agent" });
  expect(within(summary).getByRole("status")).toHaveTextContent(
    "Process running · relay readiness unverified",
  );
  expect(summary).toHaveTextContent("fixture-acp");
  expect(summary).toHaveTextContent("fixture-provider");
  expect(summary).toHaveTextContent("fixture-model");
  expect(summary).toHaveTextContent("/fixture/workspace");
  expect(summary).toHaveTextContent(
    "Saved settings; environment overrides may apply.",
  );
  expect(summary).toHaveTextContent(
    "Saved revision 3 is not running yet (running revision 2).",
  );
  // The host error is owned by the actions section, not repeated here.
  expect(summary).not.toHaveTextContent("Last start exited early.");
  expect(
    screen.getByRole("region", { name: "Local agent actions" }),
  ).toHaveTextContent("Last start exited early.");
  expect(summary).not.toHaveTextContent("Process stopped");
  expect(within(summary).queryByText("Instructions")).toBeNull();
  await userEvent.click(within(summary).getByText("Host diagnostics"));
  expect(
    within(summary).getByText(/spawned pid 42\s+listener exited/),
  ).toBeVisible();
  // Values that could be secrets never reach this view.
  expect(summary).not.toHaveTextContent("EXAMPLE_TOKEN");
  expect(summary).not.toHaveTextContent("--literal");

  community.move(elsewhere);
  expect(screen.getByRole("region", { name: "Profile details" })).toBeVisible();
  const moved = await screen.findByRole("region", { name: "Local agent" });
  // Same key saved for the other community is a separate native record.
  expect(within(moved).getByRole("status")).toHaveTextContent(
    "Process stopped",
  );
  expect(moved).not.toHaveTextContent("Saved revision 3 is not running");

  community.move(`https://third.example.test:${viewer}`);
  await screen.findByRole("region", { name: "Profile details" });
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
});

it("renders nothing for an unknown key in the same community", async () => {
  const { control, settle, data, agent } = heldHost();
  agent.relayUrl = "wss://relay.example.test";
  const community = relayAt(home);
  mount(control, community.relay, "cd".repeat(32));
  await settle(0, data);
  expect(control.snapshot().status).toBe("ready");
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
});

it("follows native status transitions and marks failed reads as unconfirmed evidence", async () => {
  const { control, reads, settle, data, agent } = heldHost();
  Object.assign(agent, {
    relayUrl: "wss://relay.example.test",
    status: "stopped",
    runningRevision: null,
    diagnostics: [],
  });
  mount(control, relayAt(home).relay);
  // Loading with no evidence stays public-only.
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  expect(control.snapshot().status).toBe("loading");
  expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
  await settle(0, data);
  const status = () =>
    within(screen.getByRole("region", { name: "Local agent" })).getByRole(
      "status",
    );
  expect(status()).toHaveTextContent("Process stopped");
  expect(screen.queryByText("Host diagnostics")).toBeNull();

  for (const [next, label] of [
    ["starting", "Starting process"],
    ["running", "Process running · relay readiness unverified"],
    ["failed", "Process failed"],
  ] as const) {
    agent.status = next;
    const index = reads.length;
    void control.refresh();
    await settle(index, data);
    expect(status()).toHaveTextContent(label);
  }

  let index = reads.length;
  void control.refresh();
  await settle(index, "host crashed");
  // Last evidence stays; the actions section owns the unconfirmed notice and Retry.
  expect(status()).toHaveTextContent("Process failed");
  const summary = screen.getByRole("region", { name: "Local agent" });
  expect(within(summary).queryByRole("alert")).toBeNull();
  const actions = screen.getByRole("region", { name: "Local agent actions" });
  expect(actions).toHaveTextContent("unconfirmed");

  agent.status = "running";
  index = reads.length;
  await userEvent.click(
    within(actions).getByRole("button", { name: "Retry status" }),
  );
  await settle(index, data);
  expect(status()).toHaveTextContent("Process running");
  expect(within(actions).queryByRole("alert")).toBeNull();
  expect(actions).not.toHaveTextContent("unconfirmed");
});

it("leaves the unavailable-runtime explanation to the actions section", async () => {
  const { control, settle, data, agent } = heldHost();
  agent.relayUrl = "wss://relay.example.test";
  data.runtimeAvailable = false;
  data.runtimeMessage = "Agent runtime resources are missing.";
  mount(control, relayAt(home).relay);
  await settle(0, data);
  const summary = await screen.findByRole("region", { name: "Local agent" });
  expect(summary).not.toHaveTextContent("Agent runtime resources are missing.");
  expect(
    screen.getByRole("region", { name: "Local agent actions" }),
  ).toHaveTextContent("Agent runtime resources are missing.");
});

it("requests a read on each Info open, coalescing re-entry while one is pending", async () => {
  const { control, reads, settle, data, agent } = heldHost();
  agent.relayUrl = "wss://relay.example.test";
  mount(control, relayAt(home, true).relay);
  const reenter = async () => {
    await userEvent.click(screen.getByRole("tab", { name: "Channels" }));
    expect(screen.queryByRole("region", { name: "Local agent" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Info" }));
    await act(async () => {});
  };
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  // ProfileAgentRuntime owns this read; inventory waits before deciding its tab.
  expect(screen.queryByRole("region", { name: "Instances" })).toBeNull();
  await reenter();
  expect(reads).toHaveLength(1);
  await settle(0, data);
  await screen.findByRole("region", { name: "Local agent" });
  for (const index of [1, 2]) {
    await reenter();
    await vi.waitFor(() => expect(reads).toHaveLength(index + 1));
    expect(screen.getByRole("region", { name: "Local agent" })).toBeVisible();
    await reenter();
    expect(reads).toHaveLength(index + 1);
    await settle(index, data);
  }
});
