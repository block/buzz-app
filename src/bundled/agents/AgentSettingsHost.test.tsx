// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { RobotIcon } from "../../shared/design-system/icons";
import { useAgentSettingsHost } from "./AgentSettingsHost";

afterEach(cleanup);

function fixture({
  hosted = true,
  anotherLocal = true,
  place = "here",
  remoteSource = false,
} = {}) {
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    name: "Ada",
    place,
    type: remoteSource ? "hosted/builderlab" : "local/echo",
    config: {},
  } as Agent;
  const local = {
    key: "local/echo",
    pluginId: "local",
    revision: "1",
    id: "echo",
    title: "Echo",
    defaults: () => ({ config: {} }),
  } satisfies RegisteredAgentType;
  const remote = {
    ...local,
    key: "hosted/builderlab",
    pluginId: "hosted",
    id: "builderlab",
    title: "Builderlab",
    icon: RobotIcon,
    remote: {
      provision: vi.fn(),
      activate: vi.fn(),
      profile: vi.fn(),
      remove: vi.fn(),
    },
  } satisfies RegisteredAgentType;
  const next = { ...local, key: "local/next", id: "next", title: "Next" };
  const types = [
    local,
    ...(hosted ? [remote] : []),
    ...(anotherLocal ? [next] : []),
  ];
  const previewRetype = vi.fn(() => ({
    config: {},
    moved: [],
    dropped: [],
    settings: [],
  }));
  const retype = vi.fn();
  const agents = { previewRetype, retype } as unknown as Agents;
  function Host() {
    const host = useAgentSettingsHost({
      agents,
      agent,
      type: remoteSource ? remote : local,
      types,
    });
    return (
      <>
        {host.settingsHost.typeControl?.(false)}
        <output aria-label="Selected harness">{host.agent.type}</output>
        <output aria-label="Pending change">
          {String(Boolean(host.settingsHost.pendingSave))}
        </output>
      </>
    );
  }
  render(<Host />);
  return { previewRetype, retype, remote };
}

it.each([false, true])(
  "explains hosted choices without staging a migration (another local %s)",
  async (anotherLocal) => {
    const user = userEvent.setup();
    const { previewRetype, retype, remote } = fixture({ anotherLocal });
    await user.click(
      screen.getByRole("button", { name: "Change harness from Echo" }),
    );
    const hosted = await screen.findByRole("menuitemradio", {
      name: "Builderlab",
    });
    expect(hosted).toHaveAttribute("aria-disabled", "true");
    expect(hosted).not.toBeChecked();
    expect(hosted.querySelector("svg")).not.toBeNull();
    await user.hover(hosted);
    const help = await screen.findByRole("dialog", {
      name: "Builderlab hosting",
    });
    expect(help).toHaveTextContent(
      "This agent’s signing key is stored on this device. Buzz can’t move that identity to Builderlab yet. To run hosted, create a new Builderlab agent.",
    );
    await user.hover(help);
    expect(screen.getByRole("menu")).toBeVisible();
    expect(help).toBeVisible();
    await user.hover(hosted);
    await user.click(hosted);
    expect(screen.getByRole("menu")).toBeVisible();
    expect(screen.getByLabelText("Selected harness")).toHaveTextContent(
      "local/echo",
    );
    expect(screen.getByLabelText("Pending change")).toHaveTextContent("false");
    expect(previewRetype).not.toHaveBeenCalled();
    expect(retype).not.toHaveBeenCalled();
    expect(remote.remote.provision).not.toHaveBeenCalled();
    await user.unhover(hosted);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Builderlab hosting" }),
      ).toBeNull(),
    );
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    expect(hosted).toHaveFocus();
    expect(
      await screen.findByRole("dialog", { name: "Builderlab hosting" }),
    ).toBeVisible();
    expect(hosted).toHaveAccessibleDescription(/signing key/);
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "Echo" })).toHaveFocus();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Builderlab hosting" }),
      ).toBeNull(),
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(
      await screen.findByRole("dialog", { name: "Builderlab hosting" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Builderlab hosting" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("menu")).toBeVisible();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("dialog", { name: "Builderlab hosting" }),
    ).toBeVisible();
    expect(previewRetype).not.toHaveBeenCalled();
    expect(retype).not.toHaveBeenCalled();
  },
);

it("keeps the existing local migration flow available", async () => {
  const user = userEvent.setup();
  const { previewRetype, retype } = fixture({ hosted: false });
  await user.click(
    screen.getByRole("button", { name: "Change harness from Echo" }),
  );
  expect(
    screen.queryByRole("menuitemradio", { name: "Builderlab" }),
  ).toBeNull();
  await user.click(await screen.findByRole("menuitemradio", { name: "Next" }));
  expect(
    await screen.findByRole("dialog", { name: "Move Ada to Next?" }),
  ).toBeVisible();
  expect(previewRetype).toHaveBeenCalledWith("a".repeat(64), "local/next");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByLabelText("Selected harness")).toHaveTextContent(
    "local/next",
  );
  expect(screen.getByLabelText("Pending change")).toHaveTextContent("true");
  expect(retype).not.toHaveBeenCalled();
});

it("does not offer local migration for an agent on another device", () => {
  fixture({ place: "elsewhere" });
  expect(screen.queryByRole("button", { name: /Change harness/ })).toBeNull();
});

it("shows local harnesses as unavailable for a hosted agent and keeps help keyboard accessible", async () => {
  const user = userEvent.setup();
  const { previewRetype, retype } = fixture({
    place: "hosted",
    remoteSource: true,
  });
  const trigger = screen.getByRole("button", {
    name: "Change harness from Builderlab",
  });
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await user.keyboard("{Home}{Enter}");
  const local = await screen.findByRole("menuitemradio", { name: "Echo" });
  expect(local).toHaveFocus();
  expect(local).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitemradio", { name: "Next" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    screen.getByRole("menuitemradio", { name: "Builderlab" }),
  ).toBeChecked();
  const copy =
    "Builderlab holds this agent’s signing key. Buzz can’t move that identity to a local harness yet. To run locally, create a new agent.";
  expect(
    await screen.findByRole("dialog", { name: "Echo hosting" }),
  ).toHaveTextContent(copy);
  expect(local).toHaveAccessibleDescription(copy);
  await user.keyboard("{Enter}{Space}");
  expect(screen.getByRole("menu")).toBeVisible();
  expect(screen.getByLabelText("Pending change")).toHaveTextContent("false");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Echo hosting" })).toBeNull(),
  );
  expect(screen.getByRole("menu")).toBeVisible();
  await user.hover(local);
  expect(
    await screen.findByRole("dialog", { name: "Echo hosting" }),
  ).toBeVisible();
  await user.click(local);
  expect(screen.getByRole("menu")).toBeVisible();
  expect(previewRetype).not.toHaveBeenCalled();
  expect(retype).not.toHaveBeenCalled();
});
