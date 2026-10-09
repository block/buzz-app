// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import * as communityApi from "../../features/communities/api";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { useSyncExternalStore } from "react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function codexFixture() {
  const fixture = controlFixture();
  fixture.data.createAvailable = true;
  fixture.data.defaultWorkspace = "/fixture/workspace";
  fixture.agent.harness = {
    integration: "codex",
    command: "/tools/codex-acp",
    args: [],
    model: "",
    provider: "",
    configuration: { mode: "default" },
    environmentKeys: [],
  };
  fixture.data.harnessOptions?.push({
    id: "codex",
    command: "/tools/codex-acp",
    label: "Codex",
    available: true,
    status: "check-needed",
    defaultArgs: [],
    providers: [],
    configurationPolicy: {
      authentication: "external",
      provider: "external",
      supportedModes: ["default", "advanced"],
      model: "optional",
      effortDiscovery: "modelSpecific",
      selectorEnvironment: null,
    },
  });
  return fixture;
}

it("creates Codex directly without an inference validation phase", async () => {
  const fixture = codexFixture();
  fixture.host.prepareCreate = vi.fn(async () => ({
    id: "created",
    pubkey: "ef".repeat(32),
  }));
  const committed = deferred<typeof fixture.data>();
  fixture.host.commitCreate = vi.fn(() => committed.promise);
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  function Dialog() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return (
      <AgentCreateDialog
        control={control}
        state={state}
        destination="https://relay.example.test"
        owner={"de".repeat(32)}
        source={fixture.agent}
        onClose={() => {}}
      />
    );
  }
  render(<Dialog />);
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));

  expect(await screen.findByText("Creating agent…")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Cancel validation" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
  committed.resolve(structuredClone(fixture.data));
  control.dispose();
});
