// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { AgentsPage } from "./AgentsPage";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(
  mode = "ready",
  configure?: (fixture: ReturnType<typeof controlFixture>) => void,
) {
  const f = controlFixture();
  configure?.(f);
  f.data.agents.push({
    ...structuredClone(f.agent),
    id: "other-destination",
    relayUrl: "wss://second.example",
    revision: 7,
  });
  const read = vi.fn(async () => {
    if (mode === "error") throw Error("synthetic");
    return {
      definitions: [
        { id: "linked", name: "Library card" },
        { id: "unimported", name: "Not imported" },
      ],
      identities: [
        { pubkey: f.agent.pubkey, name: f.agent.name, definitionId: "linked" },
        {
          pubkey: "cd".repeat(32),
          name: "Not imported",
          definitionId: "unimported",
        },
      ],
    };
  });
  const owned = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    ...(mode === "unavailable" ? {} : { readAgentLibrary: read }),
    query: async () => [],
    media: () => undefined,
  });
  disposals.push(() => owned.dispose());
  const session =
    mode === "archived"
      ? {
          ...owned.session,
          archives: {
            ...owned.session.archives,
            state: () => "archived" as const,
          },
        }
      : owned.session;
  let snapshot: RelaySnapshot = {
    status: mode === "disconnected" ? "disconnected" : "ready",
    scope: "A",
    generation: 1,
    session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const control = createAgentControl(f.host);
  disposals.push(() => control.dispose());
  render(<AgentsPage relay={relay} control={control} />);
  return {
    f,
    read,
    changeScope(scope: string, generation: number) {
      snapshot = { status: "ready", scope, generation, session };
      for (const listener of listeners) listener();
    },
  };
}
it("requires exact native destination selection and never imports from Edit", async () => {
  const { f } = setup();
  const card = await screen.findByRole("article", {
    name: "Agent Library card",
  });
  fireEvent.click(within(card).getByText("Edit identity…"));
  expect(
    within(card).getByRole("button", { name: /wss:\/\/relay.example.test/ }),
  ).toHaveTextContent(f.agent.pubkey);
  fireEvent.click(
    within(card).getByRole("button", { name: /wss:\/\/second.example/ }),
  );
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Exact destination" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(f.calls.find((call) => call.action === "save")?.payload).toMatchObject(
    { id: "other-destination", expectedRevision: 7 },
  );
  // Fake rejects this second revision; the draft remains until explicit Cancel.
  await within(dialog).findByText(/Could not confirm/);
  expect(within(dialog).getByLabelText("Name")).toHaveValue(
    "Exact destination",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const unimported = screen.getByRole("article", {
    name: "Agent Not imported",
  });
  expect(
    within(unimported).getByRole("button", { name: "Edit" }),
  ).toBeDisabled();
  expect(f.calls.some((call) => call.action === "import")).toBe(false);
});
for (const mode of ["disconnected", "unavailable", "error", "archived"]) {
  it(`keeps native agents editable when the library is ${mode}`, async () => {
    const { f } = setup(mode);
    const cards = await screen.findAllByRole("article", {
      name: "Agent Fixture agent",
    });
    const card = cards[0];
    if (!card) throw Error("Native fallback card missing");
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit agent" })).toBeVisible();
    expect(f.calls.some((call) => call.action === "import")).toBe(false);
  });
}
it("remounts records for equal-generation community switches and session replacements", async () => {
  const f = setup();
  await screen.findByRole("article", { name: "Agent Library card" });
  expect(f.read).toHaveBeenCalledTimes(1);
  await act(async () => f.changeScope("B", 1));
  expect(f.read).toHaveBeenCalledTimes(2);
  await act(async () => f.changeScope("B", 2));
  expect(f.read).toHaveBeenCalledTimes(3);
});

for (const mode of ["absolute", "saved-override", "draft-override"]) {
  it(`leaves ${mode} model discovery to native validation`, async () => {
    const run = vi.fn(async () => ({
      host: "https://workspace.example.com",
      models: [],
      modelOverridden: false,
      disconnected: false,
    }));
    setup("ready", (f) => {
      Object.assign(f.agent.harness, {
        command: mode === "absolute" ? "/fixture/bin/buzz-agent" : "buzz-agent",
        provider: mode === "absolute" ? "databricks_v2" : "selector-other",
        args: [],
        databricks: { host: "https://workspace.example.com", filter: "" },
        environmentKeys:
          mode === "saved-override" ? ["BUZZ_AGENT_PROVIDER"] : [],
      });
      f.host.models = { begin: async () => 1, cancel: async () => {}, run };
    });
    const card = await screen.findByRole("article", {
      name: "Agent Library card",
    });
    fireEvent.click(within(card).getByText("Edit identity…"));
    fireEvent.click(
      within(card).getByRole("button", { name: /wss:\/\/relay.example.test/ }),
    );
    const dialog = screen.getByRole("dialog", { name: "Edit agent" });
    if (mode === "draft-override") {
      fireEvent.click(within(dialog).getByText("Advanced", { exact: true }));
      fireEvent.change(within(dialog).getByLabelText("Variable name"), {
        target: { value: "BUZZ_AGENT_PROVIDER" },
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Add variable" }),
      );
      fireEvent.change(
        within(dialog).getByLabelText("Replacement for BUZZ_AGENT_PROVIDER"),
        {
          target: { value: "databricks_v2" },
        },
      );
    }
    fireEvent.click(within(dialog).getByText("Advanced model settings"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Refresh models" }),
    );
    await within(dialog).findByText(/No models found/);
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        action: "refresh",
        edit: expect.objectContaining({
          environment:
            mode === "draft-override"
              ? { BUZZ_AGENT_PROVIDER: "databricks_v2" }
              : {},
          harness: expect.objectContaining({
            command:
              mode === "absolute" ? "/fixture/bin/buzz-agent" : "buzz-agent",
            provider: mode === "absolute" ? "databricks_v2" : "selector-other",
          }),
        }),
      }),
    );
  });
}
