// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentControl,
  type HarnessConfigurationPolicy,
} from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentHarnessEditor } from "./AgentHarnessEditor";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft } from "./agent-edit";
import { harnessPolicy } from "./harness-policy";

afterEach(cleanup);
const goose: HarnessConfigurationPolicy = {
  authentication: "harnessWithOverrides",
  provider: "selector",
  supportedModes: [],
  model: "optional",
  effortDiscovery: "unknown",
  selectorEnvironment: { model: "GOOSE_MODEL", provider: "GOOSE_PROVIDER" },
};
const pi: HarnessConfigurationPolicy = {
  ...goose,
  provider: "discovered",
  model: "withProvider",
  selectorEnvironment: null,
};

it("uses native policy after harness labels change and preserves switch clearing", async () => {
  const user = userEvent.setup();
  const fixture = controlFixture();
  function Example() {
    const [draft, setDraft] = useState({
      ...agentDraft(fixture.agent),
      command: "buzz-agent",
      provider: "databricks_v2",
      model: "old-model",
    });
    return (
      <>
        <AgentHarnessEditor
          draft={draft}
          options={[
            ...(fixture.data.harnessOptions ?? []),
            {
              command: "goose",
              label: "Bundled Goose",
              providers: [{ value: "openai", label: "OpenAI" }],
              configurationPolicy: goose,
            },
            {
              command: "/tools/buzz-pi-acp",
              label: "Installed Pi",
              providers: [],
              configurationPolicy: pi,
            },
          ]}
          piProviders={["signed-in-provider"]}
          onChange={(patch) =>
            setDraft((current) => ({ ...current, ...patch }))
          }
        />
        <output>{JSON.stringify(draft)}</output>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(
    await screen.findByRole("option", { name: "Bundled Goose" }),
  );
  expect(screen.getByRole("combobox", { name: "LLM Provider" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent('"model":""');
  expect(screen.getByRole("status")).toHaveTextContent('"provider":""');
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Installed Pi" }));
  await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
  expect(
    await screen.findByRole("option", { name: "signed-in-provider" }),
  ).toBeVisible();
  await user.click(screen.getByRole("option", { name: "signed-in-provider" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    '"provider":"signed-in-provider"',
  );
});

it("keeps provider credentials specific and hides hints for native selector overrides", () => {
  const fixture = controlFixture();
  fixture.data.harnessOptions = [
    {
      command: "goose",
      label: "Bundled Goose",
      providers: [],
      configurationPolicy: goose,
    },
  ];
  fixture.data.defaultSettings = {
    harness: "goose",
    provider: "openai",
    model: "inherited-model",
    effort: "",
    sessionPolicy: "channel",
    environmentKeys: ["GOOSE_MODEL"],
  };
  const control = createAgentControl(fixture.host);
  const draft = {
    ...agentDraft(fixture.agent),
    command: "/tools/goose-acp",
    provider: "openai",
    model: "",
  };
  const fields = (provider: string) => (
    <AgentSettingsFields
      draft={{ ...draft, provider }}
      control={control}
      state={{ status: "ready", busy: false, error: null, data: fixture.data }}
      disabled={false}
      onChange={vi.fn()}
    />
  );
  const view = render(fields("openai"));
  try {
    expect(screen.getByLabelText("OpenAI API key")).toBeVisible();
    expect(
      screen.queryByText(/Use agent defaults \(inherited-model\)/),
    ).not.toBeInTheDocument();
    view.rerender(fields("databricks"));
    expect(screen.queryByLabelText("OpenAI API key")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("resolves only existing aliases and leaves old hosts and custom commands unclassified", () => {
  const options = [
    {
      command: "goose",
      label: "Goose",
      providers: [],
      configurationPolicy: goose,
    },
  ];
  expect(harnessPolicy(options, "C:\\tools\\goose-acp.exe")).toBe(goose);
  expect(harnessPolicy(options, "/tools/custom-acp")).toBeUndefined();
  expect(harnessPolicy(options, "codex-acp")).toBeUndefined();
  expect(
    harnessPolicy(
      [{ command: "goose", label: "Goose", providers: [] }],
      "goose",
    ),
  ).toBeUndefined();
});
