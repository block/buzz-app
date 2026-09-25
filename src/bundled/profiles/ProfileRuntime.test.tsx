// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { keypair, signed } from "../../features/relay/testing";
import { profileTarget } from "../../features/profiles/target";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ProfilePanel } from "./ProfilePanel";

const viewer = keypair(),
  agent = keypair(),
  stranger = keypair();
const scope = `https://relay.example.test:${viewer.pubkey}`;
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

function agentProfile(owner = viewer) {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agent.pubkey}:`)
    .digest();
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Fixture agent", is_agent: true }),
    tags: [
      [
        "auth",
        owner.pubkey,
        "",
        bytesToHex(schnorr.sign(new Uint8Array(digest), owner.secret)),
      ],
    ],
  });
}

async function mount({
  head = agentProfile(),
  fixture = controlFixture(),
} = {}) {
  fixture.agent.pubkey = agent.pubkey;
  const control = createAgentControl(fixture.host);
  owners.push(control);
  const h = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: viewer.pubkey,
    media: () => undefined,
    query: async (filters) =>
      filters.some((filter) => filter.kinds?.includes(0)) ? [head] : [],
  });
  owners.push(h);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    scope,
    session: h.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: h.clearCache,
  };
  render(
    <ToastProvider>
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
        control={control}
      />
    </ToastProvider>,
  );
  await screen.findByRole("heading", { name: "Fixture agent" });
  await act(async () => {});
  return { fixture, user: userEvent.setup() };
}

it("shows the verified owner saved configuration and persists start on launch", async () => {
  const { fixture, user } = await mount();
  await user.click(await screen.findByRole("tab", { name: "Runtime" }));
  const configuration = screen.getByRole("region", {
    name: "Agent configuration",
  });
  for (const text of [
    "fixture-acp",
    "Only the owner",
    "/fixture/bin/buzz-acp",
    "/fixture/bin/buzz-dev-mcp",
  ])
    expect(within(configuration).getByText(text)).toBeVisible();
  expect(within(configuration).queryByText("Backend")).toBeNull();
  const model = screen.getByRole("region", { name: "Model settings" });
  expect(within(model).getByText("fixture-model")).toBeVisible();
  expect(within(model).getByText("fixture-provider")).toBeVisible();
  expect(screen.getByText("No custom servers configured.")).toBeVisible();
  const advanced = screen.getByRole("region", { name: "Advanced" });
  expect(within(advanced).getByText("EXAMPLE_TOKEN")).toBeVisible();
  expect(screen.queryByRole("region", { name: "Restart required" })).toBeNull();

  const toggle = screen.getByRole("switch", { name: "Start on launch" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(
    await screen.findByText("Fixture agent will stay manual-start only."),
  ).toBeVisible();
  expect(toggle).not.toBeChecked();
  expect(fixture.calls).toContainEqual({
    action: "startOnAppLaunch",
    payload: { id: "fixture-agent", enabled: false },
  });
  expect(fixture.agent.startOnAppLaunch).toBe(false);
  await user.click(toggle);
  expect(
    await screen.findByText("Will start Fixture agent automatically."),
  ).toBeVisible();
  expect(toggle).toBeChecked();

  await user.click(within(model).getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("dialog", { name: "Edit agent" })).toBeVisible();
});

it("keeps the saved preference and offers recovery when persistence fails", async () => {
  const fixture = controlFixture();
  fixture.failStartOnAppLaunch(true);
  const { user } = await mount({ fixture });
  await user.click(await screen.findByRole("tab", { name: "Runtime" }));
  const toggle = screen.getByRole("switch", { name: "Start on launch" });
  await user.click(toggle);
  expect(
    await screen.findByText("Failed to update startup preference."),
  ).toBeVisible();
  expect(toggle).toBeChecked();
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The host could not save settings.",
  );
  fixture.failStartOnAppLaunch(false);
  await user.click(screen.getByRole("button", { name: "Retry status" }));
  expect(toggle).not.toHaveAttribute("aria-disabled", "true");
});

it("itemizes redacted saved-versus-running differences", async () => {
  const fixture = controlFixture();
  fixture.agent.restartDiff = [
    { field: "model", change: { kind: "value", before: "old", after: "new" } },
    {
      field: "system_prompt",
      change: { kind: "text", beforeChars: 3, afterChars: 12 },
    },
    {
      field: "args",
      change: { kind: "masked", before: "••••", after: "••••" },
    },
    { field: "env.NEW_KEY", change: { kind: "added" } },
  ];
  fixture.agent.runningRevision = 1;
  fixture.agent.revision = 2;
  const { user } = await mount({ fixture });
  await user.click(await screen.findByRole("tab", { name: "Runtime" }));
  const banner = screen.getByRole("region", { name: "Restart required" });
  expect(
    within(banner).getByText(
      "Configuration changed since this agent started. Automatic restart is off for this agent — stop and respawn it to apply the changes.",
    ),
  ).toBeVisible();
  const items = within(banner)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
  expect(items).toEqual([
    "Model: old → new",
    "System prompt: 3 chars → 12 chars",
    "Args: •••• → ••••",
    "NEW_KEY (env): added",
  ]);
});

it("shows no runtime tab to unowned viewers or without a native record", async () => {
  await mount({ head: agentProfile(stranger) });
  expect(screen.queryByRole("tab", { name: "Runtime" })).toBeNull();
  cleanup();
  const fixture = controlFixture();
  fixture.data.agents = [];
  await mount({ fixture });
  await screen.findByRole("tab", { name: "Memories" });
  expect(screen.queryByRole("tab", { name: "Runtime" })).toBeNull();
});
