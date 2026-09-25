// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { agentDraft } from "./agent-edit";
import { AgentEditor } from "./AgentEditor";

afterEach(cleanup);

it("reviews a requested model update before saving it", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const state = control.snapshot();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={state}
      initialDraft={{ ...agentDraft(fixture.agent), model: "gpt-6-sol" }}
      notice="Requested by an agent. Review every field before saving."
      onClose={() => {}}
    />,
  );

  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
    "gpt-6-sol",
  );
  expect(screen.getByText(/Requested by an agent/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(fixture.calls.at(-1)).toMatchObject({
      action: "save",
      payload: { edit: { harness: { model: "gpt-6-sol" } } },
    }),
  );
  control.dispose();
});
