// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentConnectionForm, connectionDraft } from "./AgentConnectionSetup";
import type { Agents, RegisteredAgentType } from "./service";
import type { PortableAgent } from "./native";

afterEach(cleanup);
const candidate: PortableAgent = {
  source: "installed",
  pubkey: "a".repeat(64),
  name: "Helper",
  relay: "wss://example.test",
  connection: {
    runtime: "goose",
    provider: "anthropic",
    model: "saved-model",
    effort: "high",
  },
};
const type = {
  key: "buzz.goose/goose",
  title: "Goose",
  defaults: () => ({ config: { model: "", effort: "" } }),
  importShared: (saved: {
    runtime?: string;
    provider?: string;
    model: string;
  }) =>
    saved.runtime === "goose"
      ? { provider: saved.provider, model: saved.model, effort: "" }
      : undefined,
} as RegisteredAgentType;

it("restores compatible saved selections without silently substituting an unavailable runtime", () => {
  expect(connectionDraft(candidate, [type])).toEqual({
    type: type.key,
    config: { provider: "anthropic", model: "saved-model", effort: "high" },
  });
  expect(
    connectionDraft(
      {
        ...candidate,
        connection: { runtime: "buzz-agent", model: "saved-model" },
      },
      [type],
    ),
  ).toBeUndefined();
  expect(
    connectionDraft({ ...candidate, connection: { runtime: "goose" } }, [type])
      ?.config,
  ).toMatchObject({ model: "", effort: "" });
});

it("connects the exact identity with reviewed defaults and retains errors for retry", async () => {
  const port = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValue({ notes: [] });
  const types = [type];
  const snapshot = {};
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm agents={agents} candidate={candidate} scope="scope" />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connection interrupted",
  );
  expect(port).toHaveBeenCalledWith({
    source: "installed",
    pubkey: candidate.pubkey,
    type: type.key,
    scope: "scope",
    config: { provider: "anthropic", model: "saved-model", effort: "high" },
  });
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(
    await screen.findByRole("heading", { name: / connected$/ }),
  ).toBeVisible();
});

it("shows setup only for the exact owned DM identity and hides it when that agent is online", async () => {
  const { schnorr } = await import("@noble/curves/secp256k1.js");
  const { bytesToHex } = await import("nostr-tools/utils");
  const secret = new Uint8Array(32);
  secret[31] = 1;
  const viewer = bytesToHex(schnorr.getPublicKey(secret));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nostr:agent-auth:${candidate.pubkey}:`),
  );
  const profile = {
    id: "f".repeat(64),
    kind: 0,
    pubkey: candidate.pubkey,
    created_at: 1,
    content: "{}",
    tags: [
      [
        "auth",
        viewer,
        "",
        bytesToHex(schnorr.sign(new Uint8Array(digest), secret)),
      ],
    ],
  };
  const view = { status: "ready", events: [profile] };
  const choices = { identities: [] };
  const profiles = new Map();
  const listeners = new Set<() => void>();
  let presence = "offline";
  const noop = () => () => {};
  const session = {
    scope: "scope",
    viewer,
    observe: () => ({
      snapshot: () => view,
      subscribe: noop,
      dispose: () => {},
    }),
    profiles: { subscribe: noop, snapshot: () => profiles, event: () => profile },
    agentChoices: { subscribe: noop, snapshot: () => choices },
    presence: {
      status: () => presence,
      subscribe: (_key: string, listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as import("../relay/session").RelaySession;
  const types = [type];
  const snapshot = {};
  const portable = vi.fn(async () => ({
    agents: [candidate],
    warnings: [],
    here: [],
  }));
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: noop,
    find: () => undefined,
    portable,
  } as unknown as Agents;
  const channel = {
    id: "dm",
    name: "Helper",
    channelType: "dm",
    members: [viewer, candidate.pubkey],
    viewerRole: "member",
  } as import("../relay/contracts").ChannelSummary;
  const { AgentConnectionSetup } = await import("./AgentConnectionSetup");
  const { AgentsContext } = await import("./react");
  const { act } = await import("@testing-library/react");
  render(
    <AgentsContext.Provider value={agents}>
      <AgentConnectionSetup session={session} channel={channel} />
    </AgentsContext.Provider>,
  );
  expect(
    await screen.findByRole("heading", { name: /^Connect / }),
  ).toBeVisible();
  expect(portable).toHaveBeenCalledOnce();
  act(() => {
    presence = "online";
    for (const listener of [...listeners]) listener();
  });
  expect(
    screen.queryByRole("heading", { name: /^Connect / }),
  ).toBeNull();
});

it("removes a disabled harness from the choices and never imports from a preview", async () => {
  const { act } = await import("@testing-library/react");
  let types: readonly RegisteredAgentType[] = [type];
  const snapshot = {};
  const listeners = new Set<() => void>();
  const port = vi.fn();
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope="scope"
      preview
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Preview only");
  expect(port).not.toHaveBeenCalled();
  act(() => {
    types = [];
    for (const listener of [...listeners]) listener();
  });
  expect(
    screen.getByRole("combobox", { name: "Harness" }),
  ).toHaveTextContent("Choose harness");
  expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  expect(screen.queryByText("Goose")).toBeNull();
});
