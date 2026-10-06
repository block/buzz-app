// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type {
  AgentTypes,
  RegisteredAgentType,
} from "../../features/agent-types/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ProfileAgentRuntime } from "../profiles/ProfileAgentRuntime";
import { relayOrigin } from "../../features/communities/destination";
import { relayPartition } from "../../features/relay/partition";
import { AgentEditor } from "./AgentEditor";

afterEach(cleanup);

const type = {
  key: "example.plugin/assistant",
  pluginId: "example.plugin",
  revision: "test",
  id: "assistant",
  title: "Assistant",
  Configure: () => <p>Assistant settings</p>,
  subscription: () => ({ kinds: [9] }),
  run: () => {},
  secrets: [
    { name: "API_KEY", label: "API key" },
    { name: "TOKEN", label: "Token", optional: true },
  ],
} as unknown as RegisteredAgentType;
const types = [type];
const activity = {};
const agentTypes: AgentTypes = {
  register: () => {},
  snapshot: () => types,
  activity: () => activity,
  subscribe: () => () => {},
};

async function pluginFixture(environmentKeys: string[]) {
  const fixture = controlFixture();
  Object.assign(fixture.agent, {
    workspace: "",
    harness: {
      command: "",
      args: [],
      model: "",
      provider: "",
      environmentKeys,
    },
    plugin: { type: type.key, config: {} },
  });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  return { fixture, control };
}

it("opens a plugin agent from its profile and saves a name change", async () => {
  const { fixture, control } = await pluginFixture(["API_KEY"]);
  render(
    <ProfileAgentRuntime
      control={control}
      agentTypes={agentTypes}
      scope={relayPartition(
        relayOrigin(fixture.agent.relayUrl),
        "cd".repeat(32),
      )}
      pubkey={fixture.agent.pubkey}
      owned
    />,
    { wrapper: ToastProvider },
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Agent instructions" }),
  );
  expect(screen.getByText("Assistant settings")).toBeVisible();
  const name = screen.getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Renamed");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(fixture.calls.at(-1)).toMatchObject({
      action: "save",
      payload: { edit: { name: "Renamed" } },
    }),
  );
  control.dispose();
});

it("removes a saved optional or retired value, never a required one", async () => {
  const { fixture, control } = await pluginFixture([
    "API_KEY",
    "TOKEN",
    "OLD_TOKEN",
  ]);
  const onClose = vi.fn();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      agentTypes={agentTypes}
      state={control.snapshot()}
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );
  expect(
    screen.queryByRole("button", { name: "Remove saved API key" }),
  ).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Remove saved Token" }),
  );
  expect(screen.getByPlaceholderText("Will remove on save")).toBeVisible();
  // Taking it back sends nothing for that name.
  await userEvent.click(
    screen.getByRole("button", { name: "Keep saved Token" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Remove saved Token" }),
  );
  expect(screen.getByText(/is no longer used/)).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Remove saved OLD_TOKEN" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(fixture.calls.at(-1)).toMatchObject({
      action: "save",
      payload: { edit: { environment: { TOKEN: null, OLD_TOKEN: null } } },
    }),
  );
  control.dispose();
});
