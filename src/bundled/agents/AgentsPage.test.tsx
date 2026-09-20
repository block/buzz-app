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
  waitFor,
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
  const control = createAgentControl(mode === "browser" ? null : f.host);
  disposals.push(() => control.dispose());
  render(<AgentsPage relay={relay} control={control} />);
  return {
    f,
    read,
    control,
    changeScope(scope: string, generation: number) {
      snapshot = { status: "ready", scope, generation, session };
      for (const listener of listeners) listener();
    },
  };
}
it("shows one managed card per exact destination and keeps unimported templates out of My agents", async () => {
  const { f } = setup();
  const cards = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(cards).toHaveLength(2);
  const card = cards.find((entry) =>
    entry.textContent?.includes("wss://second.example"),
  );
  if (!card) throw Error("Second destination missing");
  expect(
    within(screen.getByRole("region", { name: "My agents" })).queryByText(
      "Not imported",
    ),
  ).toBeNull();
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Exact destination" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(f.calls.find((call) => call.action === "save")?.payload).toMatchObject(
    { id: "other-destination", expectedRevision: 7 },
  );
  // The synthetic host rejects this revision; failed save must retain the draft.
  await within(dialog).findByText(/Could not confirm/);
  expect(within(dialog).getByLabelText("Name")).toHaveValue(
    "Exact destination",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
  expect(screen.queryByText("Old Buzz library", { exact: true })).toBeNull();
  expect(screen.getByText("Add agent", { exact: true })).toBeVisible();
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
    fireEvent.click(
      within(card).getByRole("button", { name: "Actions for Fixture agent" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit agent" })).toBeVisible();
    expect(f.calls.some((call) => call.action === "import")).toBe(false);
  });
}
it("remounts records for equal-generation community switches and session replacements", async () => {
  const f = setup();
  await screen.findAllByRole("article", { name: "Agent Fixture agent" });
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
    const cards = await screen.findAllByRole("article", {
      name: "Agent Fixture agent",
    });
    const card = cards.find((entry) =>
      entry.textContent?.includes("wss://relay.example.test"),
    );
    if (!card) throw Error("Primary destination missing");
    fireEvent.click(
      within(card).getByRole("button", { name: "Actions for Fixture agent" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
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

it("keeps lifecycle controls visible and reports failure without disabling recovery Stop", async () => {
  const { f, control } = setup();
  const [card] = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  if (!card) throw Error("Missing managed card");
  expect(
    within(card).getByText("Process running · relay readiness unverified"),
  ).toBeVisible();
  fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
  await within(card).findByRole("button", { name: "Start" });
  expect(f.calls.at(-1)).toEqual({
    action: "stop",
    payload: { id: "fixture-agent" },
  });
  f.host.action = async () => {
    throw "synthetic start failure";
  };
  fireEvent.click(within(card).getByRole("button", { name: "Start" }));
  await screen.findByRole("button", { name: "Retry status" });
  expect(within(card).getByRole("button", { name: "Start" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "Stop" })).toBeEnabled();
  await act(async () => control.refresh());
  expect(within(card).getByRole("button", { name: "Start" })).toBeEnabled();
  f.data.runtimeAvailable = false;
  await act(async () => control.refresh());
  expect(within(card).getByRole("button", { name: "Start" })).toBeDisabled();
  expect(
    within(card).getByText(/bundled agent runtime is unavailable/),
  ).toBeVisible();
});
it("focuses the imported managed identity without starting it", async () => {
  const { f } = setup();
  await screen.findAllByRole("article", { name: "Agent Fixture agent" });
  fireEvent.click(screen.getByText("Add agent", { exact: true }));
  fireEvent.change(screen.getByLabelText("Destination community"), {
    target: { value: "wss://third.example" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Preview selected library" }),
  );
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Fixture agent/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Import selected identities" }),
  );
  const notice = await screen.findByText(
    "Imported, not started. Review settings, then Start.",
  );
  const imported = notice.closest("article");
  if (!imported) throw Error("Imported card missing");
  expect(imported).toHaveTextContent("wss://third.example");
  expect(notice.parentElement).toHaveFocus();
  expect(within(imported).getByRole("button", { name: "Start" })).toBeEnabled();
  expect(f.calls.some((call) => call.action === "start")).toBe(false);
});

it("keeps the read-only library available when native management is unavailable", async () => {
  setup("browser");
  const card = await screen.findByRole("article", {
    name: "Agent Not imported",
  });
  expect(
    within(card).queryByRole("button", { name: /Actions|Start|Edit/ }),
  ).toBeNull();
  expect(screen.queryByText("Add agent", { exact: true })).toBeNull();
  expect(screen.getByText(/This browser cannot run/)).toBeVisible();
});
it("keeps everyday editing focused and preserves hidden harness settings on Save", async () => {
  const { f } = setup();
  const original = structuredClone(f.agent.harness);
  const [card] = await screen.findAllByRole("article", {
    name: "Agent Fixture agent",
  });
  if (!card) throw Error("Missing managed card");
  fireEvent.click(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit agent" });
  expect(within(dialog).getByLabelText("Name")).toBeVisible();
  expect(within(dialog).getByLabelText("Agent instructions")).toBeVisible();
  expect(within(dialog).getByLabelText("Model", { exact: true })).toBeVisible();
  expect(
    within(dialog).getByLabelText("Harness", { exact: true }),
  ).not.toBeVisible();
  expect(
    within(dialog).getByLabelText("Provider", { exact: true }),
  ).not.toBeVisible();
  fireEvent.change(within(dialog).getByLabelText("Agent instructions"), {
    target: { value: "Focused everyday edit" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await within(dialog).findByText("Saved. Running work was not restarted.");
  expect(f.agent.harness).toEqual(original);
  fireEvent.click(within(dialog).getByText("Advanced", { exact: true }));
  expect(
    within(dialog).getByLabelText("Harness", { exact: true }),
  ).toBeVisible();
  expect(
    within(dialog).getByLabelText("Provider", { exact: true }),
  ).toBeVisible();
});

it("credential import keeps real Stop controls reachable without trapping the editor", async () => {
  let releaseImport!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  const { f, control } = setup("ready", (fixture) => {
    const commit = fixture.host.commitImport;
    fixture.host.commitImport = async (...args) => {
      await gate;
      return commit(...args);
    };
    fixture.host.action = async (id, action) => {
      fixture.calls.push({ action, payload: { id } });
      const agent = fixture.data.agents.find((agent) => agent.id === id);
      if (!agent) throw Error("Missing action target");
      agent.enabled = action !== "stop";
      agent.status = action === "stop" ? "stopped" : "running";
      return structuredClone(fixture.data);
    };
  });
  try {
    const cards = await screen.findAllByRole("article", {
      name: "Agent Fixture agent",
    });
    const [first, other] = cards;
    if (!first || !other) throw Error("Missing managed cards");
    fireEvent.click(screen.getByText("Add agent", { exact: true }));
    fireEvent.change(screen.getByLabelText("Destination community"), {
      target: { value: "wss://third.example" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview selected library" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Fixture agent/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Import selected identities" }),
    );
    expect(control.snapshot().busy).toBe(true);
    expect(within(first).getByRole("button", { name: "Stop" })).toBeEnabled();
    fireEvent.click(
      within(first).getByRole("button", { name: "Actions for Fixture agent" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit agent" });
    fireEvent.click(
      within(dialog).getByText("Runtime and identity", { exact: true }),
    );
    expect(within(dialog).getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Restart" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Close editor" }),
    ).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    await within(dialog).findByText(
      "Disabled · mentions will not wake this agent",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close editor" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // Recovery for a different exact identity stays accessible behind the dialog.
    fireEvent.click(within(other).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(f.calls.filter((call) => call.action === "stop")).toEqual([
        { action: "stop", payload: { id: "fixture-agent" } },
        { action: "stop", payload: { id: "other-destination" } },
      ]),
    );
    await act(async () => {
      releaseImport();
      await gate;
    });
    await waitFor(() => expect(control.snapshot().busy).toBe(false));
    expect(
      screen.queryByText("Imported, not started. Review settings, then Start."),
    ).toBeNull();
    await act(async () => control.refresh());
    const imported = control
      .snapshot()
      .data?.agents.find((agent) => agent.id === "second-fixture");
    expect(imported).toMatchObject({ enabled: false, status: "stopped" });
  } finally {
    await act(async () => {
      releaseImport();
      await gate;
    });
  }
});
