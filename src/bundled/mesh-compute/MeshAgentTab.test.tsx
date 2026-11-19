// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentViewProps } from "../../features/agents/service";
import { MeshAgentTab, modelChoices } from "./MeshAgentTab";
import type { MeshAgentConfig } from "./meshAgent";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const entry = (memberPubkey: string, modelId: string, modelName?: string) => ({
  deviceId: null,
  memberPubkey,
  modelId,
  modelName: modelName ?? null,
  deviceName: null,
  vramGb: null,
});
const MIMO = "unsloth/MiMo-V2.6-Flash-GGUF:Q4_K_M";
const GEMMA = "unsloth/gemma-4-26B-GGUF:Q4_K_M";

function renderTab(config: object = {}) {
  const save = vi.fn(async (_config: MeshAgentConfig) => {});
  const props = {
    agent: { relay: "wss://community.example", config },
    save,
  } as unknown as AgentViewProps<MeshAgentConfig>;
  render(<MeshAgentTab {...props} />);
  return save;
}

it("lists each shared model once, with how many members share it", () => {
  expect(
    modelChoices([
      entry("a", MIMO),
      entry("b", MIMO),
      entry("a", GEMMA, GEMMA),
    ]),
  ).toEqual([
    { id: GEMMA, label: "gemma-4-26B · Q4_K_M", members: 1 },
    { id: MIMO, label: "MiMo-V2.6-Flash · Q4_K_M", members: 2 },
  ]);
});

it("saves a model chosen under Advanced, and Auto clears it", async () => {
  const user = userEvent.setup();
  native.invoke.mockResolvedValue({
    unavailable: null,
    entries: [entry("a", MIMO), entry("b", MIMO), entry("a", GEMMA)],
  });
  const save = renderTab();
  expect(native.invoke).toHaveBeenCalledWith("mesh_compute_inventory", {
    community: "https://community.example",
  });
  await user.click(screen.getByRole("button", { name: "Advanced" }));
  const model = screen.getByRole("combobox", { name: "Model" });
  expect(model).toHaveTextContent("Auto (recommended)");
  await user.click(model);
  await user.click(
    await screen.findByRole("option", {
      name: "MiMo-V2.6-Flash · Q4_K_M · 2 sharing",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ model: MIMO }));

  cleanup();
  const clear = renderTab({ model: MIMO });
  const saved = screen.getByRole("combobox", { name: "Model" });
  await waitFor(() => expect(saved).toHaveTextContent("MiMo-V2.6-Flash"));
  await user.click(saved);
  await user.click(
    await screen.findByRole("option", { name: "Auto (recommended)" }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(clear.mock.calls[0]?.[0]).not.toHaveProperty("model");
});

it("keeps a saved model no one is sharing, and says so", async () => {
  native.invoke.mockResolvedValue({
    unavailable: null,
    entries: [entry("a", GEMMA)],
  });
  renderTab({ model: MIMO });
  // A saved model opens Advanced so the choice is visible.
  const model = screen.getByRole("combobox", { name: "Model" });
  await waitFor(() =>
    expect(model).toHaveTextContent(
      "MiMo-V2.6-Flash · Q4_K_M · not shared now",
    ),
  );
  expect(
    screen.getByText(/No one in this community is sharing this model/),
  ).toBeVisible();
});
