// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentModelPicker } from "./AgentModelPicker";
import { agentDraft } from "./agent-edit";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);

it("Goose Databricks v2 browses live IDs and flags an unlisted short name", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [
      {
        id: "data_workflow_tools.goose.goose-glm-5-3",
        name: "data_workflow_tools.goose.goose-glm-5-3",
      },
    ],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = {
    begin: async () => 1,
    run,
    cancel: async () => {},
  };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  function Editor() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "/usr/local/bin/goose",
      provider: "databricks_v2",
      model: "goose-glm-5-3",
    });
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={{ host: "", filter: "" }}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await screen.findByText(/not in Goose’s current Databricks v2 list/);
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        host: "",
        filter: "",
        action: "connect",
      }),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await user.click(
      screen.getByRole("option", {
        name: /data_workflow_tools\.goose\.goose-glm-5-3/,
      }),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "data_workflow_tools.goose.goose-glm-5-3",
    );
    expect(
      screen.queryByText(/not in Goose’s current Databricks v2 list/),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

for (const opening of ["typing", "ArrowDown", "closed"] as const) {
  it(`${opening}: only explicit Browse or Retry may connect the actual combobox`, async () => {
    const f = controlFixture();
    const begin = vi.fn(async () => 1);
    const run = vi.fn(async () => {
      throw "Synthetic sign-in failure";
    });
    const cancel = vi.fn(async () => {});
    f.host.models = { begin, run, cancel };
    const control = createAgentControl(f.host);
    const user = userEvent.setup();
    function Editor() {
      const [draft, setDraft] = useState(agentDraft(f.agent));
      return (
        <AgentModelPicker
          draft={draft}
          control={control}
          defaults={{ host: "https://workspace.example.com", filter: "" }}
          onChange={(patch) =>
            setDraft((current) => ({ ...current, ...patch }))
          }
        />
      );
    }
    const view = render(<Editor />);
    try {
      const input = screen.getByRole("combobox", { name: "Model" });
      // Base UI intentionally aria-hides controls outside the open list from
      // virtual cursors; pointer/Tab access remains. Capture the real trigger.
      const browse = screen.getByRole("button", { name: "Browse models" });
      if (opening === "typing") {
        await user.clear(input);
        await user.type(input, "custom-model");
      } else if (opening === "ArrowDown") {
        await user.click(input);
        await user.keyboard("{ArrowDown}");
      }
      if (opening !== "closed")
        expect(input).toHaveAttribute("aria-expanded", "true");
      expect(begin).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      if (opening === "ArrowDown") {
        await user.tab();
        expect(browse).toHaveFocus();
        await user.keyboard("{Enter}");
      } else await user.click(browse);
      // Base UI defers the trigger's mousedown toggle to the next frame. Assert
      // only after that callback, not whichever side of it userEvent happened to finish.
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      await screen.findByText("Synthetic sign-in failure");
      expect(begin).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledExactlyOnceWith(
        1,
        expect.objectContaining({ action: "connect" }),
      );
      expect(input).toHaveAttribute("aria-expanded", "true");
      if (opening === "typing") expect(input).toHaveValue("custom-model");
      await user.keyboard("{Escape}");
      await user.click(input);
      await user.keyboard("{ArrowDown}");
      expect(run).toHaveBeenCalledOnce();
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Retry models" }));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    } finally {
      view.unmount();
      control.dispose();
    }
  });
}
