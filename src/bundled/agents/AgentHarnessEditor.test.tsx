// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AgentHarnessEditor } from "./AgentHarnessEditor";
import { agentDraft } from "./agent-edit";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);
it("keeps custom mode separate from saved values and supports an unset provider", async () => {
  const f = controlFixture();
  const user = userEvent.setup();
  function Example() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "buzz-agent",
      provider: "provider",
    });
    return (
      <>
        <AgentHarnessEditor
          draft={draft}
          options={[
            {
              command: "buzz-agent",
              label: "Buzz Agent",
              providers: [{ value: "provider", label: "Provider" }],
            },
          ]}
          onChange={(patch) =>
            setDraft((current) => ({ ...current, ...patch }))
          }
        />
        <output>
          {JSON.stringify({ command: draft.command, provider: draft.provider })}
        </output>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(
    await screen.findByRole("option", {
      name: "Custom executable / current value",
    }),
  );
  expect(screen.getByRole("textbox", { name: "Executable" })).toHaveValue(
    "buzz-agent",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    '{"command":"buzz-agent","provider":"provider"}',
  );
  await user.clear(screen.getByRole("textbox", { name: "Executable" }));
  await user.type(
    screen.getByRole("textbox", { name: "Executable" }),
    "/custom/agent",
  );
  expect(screen.getByRole("textbox", { name: "Custom provider" })).toHaveValue(
    "provider",
  );
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(await screen.findByRole("option", { name: "Not set" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    '{"command":"/custom/agent","provider":""}',
  );
});

it("hides Provider for Codex, including absolute executables, and restores it for other harnesses", async () => {
  const f = controlFixture();
  const draft = { ...agentDraft(f.agent), command: "codex-acp", provider: "" };
  const props = { options: [], onChange: () => {} };
  const view = render(<AgentHarnessEditor {...props} draft={draft} />);
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  view.rerender(
    <AgentHarnessEditor
      {...props}
      draft={{ ...draft, command: "/bin/codex-acp" }}
    />,
  );
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  view.rerender(
    <AgentHarnessEditor
      {...props}
      draft={{ ...draft, command: "buzz-agent" }}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Provider" })).toBeVisible();
});
