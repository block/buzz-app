// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Dialog } from "@base-ui/react/dialog";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentImport } from "./AgentImport";
afterEach(cleanup);
it.each([false, true])(
  "reviews only the selected key and excludes saved keys across destinations: saved=%s",
  async (saved) => {
    const f = controlFixture();
    const key = "cd".repeat(32);
    const control = createAgentControl(f.host);
    const imported = vi.fn();
    const mounted = render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Popup>
            <AgentImport
              control={control}
              disabled={false}
              initialDestination="https://relay.example.test"
              initialSource="development"
              selectedPubkey={key}
              selectedName="Selected"
              managedAgents={
                saved
                  ? [
                      {
                        ...f.agent,
                        pubkey: key,
                        relayUrl: "wss://elsewhere.test",
                      },
                    ]
                  : []
              }
              onImported={imported}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>,
    );
    try {
      expect(
        await screen.findByRole("heading", { name: "Import Selected?" }),
      ).toBeVisible();
      const submit = screen.getByRole("button", { name: "Import agent" });
      if (saved) {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "already imported",
        );
        expect(submit).toBeDisabled();
        expect(f.calls.some((call) => call.action === "import")).toBe(false);
      } else {
        await waitFor(() => expect(submit).toBeEnabled());
        fireEvent.click(submit);
        await waitFor(() => expect(imported).toHaveBeenCalledOnce());
        expect(imported.mock.calls[0]?.[0]).toEqual([
          expect.objectContaining({ pubkey: key, enabled: false }),
        ]);
      }
    } finally {
      mounted.unmount();
      control.dispose();
    }
  },
);
const notice = /Old team instructions saved inside this agent's prompt/;
const previewWith = (
  f: ReturnType<typeof controlFixture>,
  candidates: { id: string; name: string; stripsTeamInstructions: boolean }[],
) => {
  f.host.previewImport = async (_source, destination) => ({
    token: "fixture-preview",
    sourcePath: "/fixture/managed-agents.json",
    warnings: [],
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      pubkey: String(index + 1).repeat(64),
      relayUrl: destination,
    })),
  });
};
const mount = (
  control: ReturnType<typeof createAgentControl>,
  props: Partial<Parameters<typeof AgentImport>[0]> = {},
) =>
  render(
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Popup>
          <AgentImport
            control={control}
            disabled={false}
            initialDestination="wss://relay.example.test"
            initialSource="development"
            managedAgents={[]}
            {...props}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>,
  );
it("notes stripped team instructions only for agents whose prompt is cut", async () => {
  const f = controlFixture();
  previewWith(f, [
    { id: "cut", name: "Cut", stripsTeamInstructions: true },
    { id: "kept", name: "Kept", stripsTeamInstructions: false },
  ]);
  const control = createAgentControl(f.host);
  const mounted = mount(control);
  try {
    await screen.findByRole("button", { name: "Import Kept" });
    expect(screen.getAllByText(notice)).toHaveLength(1);
    const cut = screen.getByRole("button", {
      name: "Import Cut",
    }).parentElement;
    expect(cut).toHaveTextContent(notice);
    mounted.unmount();
    mount(control, { selectedPubkey: "2".repeat(64), selectedName: "Kept" });
    await screen.findByRole("heading", { name: "Import Kept?" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Import agent" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText(notice)).toBeNull();
    cleanup();
    mount(control, { selectedPubkey: "1".repeat(64), selectedName: "Cut" });
    expect(await screen.findByText(notice)).toBeVisible();
  } finally {
    control.dispose();
  }
});
it("hides the stripped-instructions notice on the repair action", async () => {
  const f = controlFixture();
  previewWith(f, [
    { id: f.agent.id, name: "Repair me", stripsTeamInstructions: true },
  ]);
  const control = createAgentControl(f.host);
  const mounted = mount(control, {
    managedAgents: [{ ...f.agent, needsTeamImport: true }],
  });
  try {
    await screen.findByRole("button", {
      name: "Repair team import for Repair me",
    });
    expect(screen.queryByText(notice)).toBeNull();
  } finally {
    mounted.unmount();
    control.dispose();
  }
});
