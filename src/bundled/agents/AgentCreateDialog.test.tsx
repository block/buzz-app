// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  const onClose = vi.fn();
  function Dialog() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return (
      <AgentCreateDialog
        control={control}
        state={state}
        destination="https://relay.example.test"
        owner={"de".repeat(32)}
        source={fixture.agent}
        onClose={onClose}
      />
    );
  }
  render(<Dialog />);
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));

  expect(await screen.findByText("Creating agent…")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Cancel validation" }),
  ).not.toBeInTheDocument();
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toBeDisabled();
  await userEvent.click(close);
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  committed.resolve(structuredClone(fixture.data));
  control.dispose();
});

it.each(["starting", "publishing"] as const)(
  "prevents dismissal during %s",
  async (phase) => {
    const fixture = codexFixture();
    fixture.agent.status = phase === "starting" ? "stopped" : "running";
    const control = createAgentControl(fixture.host);
    await control.refresh();
    const pending = deferred<never>();
    const onClose = vi.fn();
    control.create = vi.fn().mockResolvedValue(fixture.agent);
    vi.spyOn(control, "action").mockImplementation(async () => {
      if (phase === "starting") return pending.promise;
      return {
        ...fixture.data,
        agents: [{ ...fixture.agent, status: "running" }],
      };
    });
    vi.spyOn(control, "publishProfile").mockImplementation(
      () => pending.promise,
    );
    const view = render(
      <AgentCreateDialog
        control={control}
        state={control.snapshot()}
        destination="https://relay.example.test"
        owner={"de".repeat(32)}
        source={fixture.agent}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() =>
      expect(
        phase === "starting" ? control.action : control.publishProfile,
      ).toHaveBeenCalled(),
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
    control.dispose();
  },
);
