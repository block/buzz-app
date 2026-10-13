// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentViewProps } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { defaults, type Config } from "./config";
import { CodexProvider, createTabs } from "./tabs";
import { CodexRuntime } from "./runtime";
import type { Wire } from "./rpc";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  // jsdom has no layout observers; the compact model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
function fixture({
  signedIn = true,
  saved = {},
  turns = () => ({ result: { data: [] } }),
}: {
  signedIn?: boolean;
  saved?: Record<string, unknown>;
  turns?: (threadId: string) => Wire;
} = {}) {
  const processes: { end: ReturnType<typeof vi.fn> }[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    const exit = deferred<number | null>();
    const process = {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.id == null) return;
        if (wire.method === "thread/turns/list") {
          const reply = turns((wire.params as { threadId: string }).threadId);
          options?.onStdout?.(`${JSON.stringify({ id: wire.id, ...reply })}\n`);
          return;
        }
        let result: unknown = {};
        if (wire.method === "account/read")
          result = {
            account: signedIn
              ? { type: "chatgpt", email: "test@example.com" }
              : null,
          };
        if (wire.method === "model/list")
          result = {
            data: [
              {
                id: "a",
                model: "model-a",
                displayName: "Model A",
                description: "Model A description.",
                isDefault: true,
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "high" },
                ],
              },
              {
                id: "b",
                model: "model-b",
                displayName: "Model B",
                description: "Model B description.",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              },
            ],
            nextCursor: null,
          };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, result })}\n`);
      },
      end: vi.fn(async () => {
        exit.resolve(0);
      }),
      kill: vi.fn(async () => {
        exit.resolve(null);
      }),
      exited: exit.promise,
    };
    processes.push(process);
    return process;
  });
  const provider = new CodexProvider(spawn, localStorage);
  const relay = {
    snapshot: () => ({
      status: "ready",
      session: {
        channels: {
          list: () => ({ channels: [{ id: "channel", name: "general" }] }),
        },
      },
    }),
  } as unknown as RelayData;
  const sessions = {
    getItem: () => JSON.stringify(saved),
    setItem: () => undefined,
  } as unknown as Storage;
  const runtime = new CodexRuntime(
    spawn,
    () => relay,
    sessions,
    (raw) => provider.resolve(raw),
  );
  const tabs = createTabs(provider, runtime, spawn);
  const props = (settings = defaults, save = vi.fn(async () => {})) =>
    ({
      agent: { pubkey: "a".repeat(64), name: "Sol", config: settings },
      save,
    }) as unknown as AgentViewProps<Config>;
  return { spawn, processes, provider, tabs, props };
}
it("lists saved conversations and shows one's Codex thread, or that Codex no longer has it", async () => {
  const root = "e".repeat(64);
  const f = fixture({
    saved: {
      [JSON.stringify(["channel", "channel"])]: {
        threadId: "deleted",
        workspace: "/w",
        at: 1,
      },
      [JSON.stringify(["channel", root])]: {
        threadId: "kept",
        workspace: "/w",
        at: 2,
      },
    },
    turns: (threadId) =>
      threadId === "kept"
        ? {
            result: {
              data: [
                {
                  id: "turn-1",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  items: [
                    {
                      type: "userMessage",
                      id: "u",
                      content: [
                        { type: "text", text: 'Request: "what changed?"' },
                      ],
                    },
                    { type: "agentMessage", id: "a", text: "Two files." },
                  ],
                },
              ],
              nextCursor: "older",
            },
          }
        : {
            error: { code: -32600, message: `thread not loaded: ${threadId}` },
          },
  });
  const save = vi.fn();
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  fireEvent.click(screen.getByText("Runtime diagnostics"));
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: "View transcript" })[
      index
    ] as HTMLElement;
  expect(screen.getByText(/#general · thread eeeeeeee/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "/draft" },
  });
  fireEvent.click(viewButton(0));
  expect(await screen.findByText("what changed?")).toBeVisible();
  expect(screen.getByText("Two files.")).toBeVisible();
  expect(screen.getByText("Showing the latest 20 turns.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).not.toHaveAttribute(
      "data-loading",
    ),
  );
  expect(screen.getByText("Two files.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(viewButton(1));
  expect(
    await screen.findByText(/Codex has no history for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Workspace")).toHaveValue("/draft");
  expect(save).not.toHaveBeenCalled();
});

it("keeps provider readiness quiet and shows recovery when needed", async () => {
  const f = fixture();
  const onClose = vi.fn();
  render(<f.tabs.ProviderDialogBody onClose={onClose} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default model")).toBeEnabled(),
  );
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Default model" }));
  expect(
    await screen.findByRole("option", { name: "Codex default (Model A)" }),
  ).toHaveAccessibleDescription("Following Codex's recommendation");
  const model = await screen.findByRole("option", { name: "Model B" });
  expect(model).toHaveAccessibleDescription("Model B description.");
  await user.click(model);
  expect(f.provider.resolve(defaults)).toEqual(defaults);
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  expect(f.provider.resolve(defaults)).toMatchObject({
    model: "model-b",
    effort: "",
  });
  expect(f.provider.resolve({ ...defaults, model: "model-a" })).toMatchObject({
    model: "model-a",
    effort: "",
  });
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByText("Runtime diagnostics")).toBeNull();

  const storageFailure = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage full");
    });
  await user.click(screen.getByRole("combobox", { name: "Default model" }));
  await user.click(await screen.findByRole("option", { name: "Model A" }));
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage full");
  expect(onClose).toHaveBeenCalledOnce();
  storageFailure.mockRestore();

  cleanup();
  const signedOut = fixture({ signedIn: false });
  render(<signedOut.tabs.ProviderDialogBody onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Codex needs you to sign in.",
  );
  expect(signedOut.provider.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Log in to Codex",
  });
  const copy = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  expect(screen.getByLabelText("Terminal command")).toHaveValue("codex login");
  fireEvent.click(
    screen.getByRole("button", { name: "Copy terminal command" }),
  );
  await waitFor(() => expect(copy).toHaveBeenCalledWith("codex login"));
  expect(
    screen.getByRole("button", { name: "Copied terminal command" }),
  ).toBeVisible();
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
});
it("applies provider precedence without rewriting records and falls back for incompatible thinking", async () => {
  const f = fixture();
  await f.provider.check();
  f.provider.saveDefaults({ model: "model-a", effort: "high" });
  const inherited = { ...defaults };
  expect(f.provider.resolve(inherited)).toMatchObject({
    model: "model-a",
    effort: "high",
  });
  expect(inherited).toEqual(defaults);
  expect(f.provider.resolve({ ...defaults, model: "model-b" })).toMatchObject({
    model: "model-b",
    effort: "medium",
  });
  expect(
    f.provider.resolve({ ...defaults, model: "model-b", effort: "high" }),
  ).toMatchObject({ model: "model-b", effort: "high" });

  f.provider.saveDefaults({ model: "model-b", effort: "medium" });
  render(<f.tabs.SettingsTab {...f.props()} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Provider default · Model B",
    ),
  );
  expect(screen.getByLabelText("Thinking")).toHaveTextContent(
    "Codex default (Medium)",
  );
  cleanup();

  localStorage.setItem("buzz.codex.provider-defaults.v1", "invalid");
  const invalid = new CodexProvider(f.spawn, localStorage);
  expect(invalid.resolve(defaults)).toEqual(defaults);
});
it("falls back for an unavailable provider default and restores it when the catalog recovers", async () => {
  localStorage.setItem(
    "buzz.codex.provider-defaults.v1",
    JSON.stringify({ version: 1, model: "model-a", effort: "high" }),
  );
  const f = fixture();
  expect(f.provider.resolve(defaults)).toMatchObject({
    model: "model-a",
    effort: "high",
  });
  const spawn = f.spawn.getMockImplementation();
  if (!spawn) throw new Error("Missing host fixture");
  f.spawn.mockImplementationOnce((id, options) =>
    spawn(id, {
      ...options,
      onStdout: (data) => {
        const wire = JSON.parse(data);
        if (Array.isArray(wire.result?.data))
          wire.result.data = wire.result.data.filter(
            (model: { model: string }) => model.model !== "model-a",
          );
        options?.onStdout?.(`${JSON.stringify(wire)}\n`);
      },
    }),
  );
  await f.provider.check();
  expect(f.provider.resolve(defaults)).toEqual(defaults);
  expect(f.provider.resolve({ ...defaults, model: "model-b" })).toMatchObject({
    model: "model-b",
    effort: "medium",
  });
  expect(
    JSON.parse(
      localStorage.getItem("buzz.codex.provider-defaults.v1") ?? "null",
    ),
  ).toMatchObject({ model: "model-a", effort: "high" });
  render(<f.tabs.ProviderDialogBody onClose={vi.fn()} />);
  expect(screen.getByLabelText("Default model")).toHaveTextContent(
    "model-a (unavailable)",
  );
  expect(screen.getByLabelText("Default thinking")).toHaveTextContent(
    "High (unavailable)",
  );
  cleanup();
  await f.provider.check();
  expect(f.provider.resolve(defaults)).toMatchObject({
    model: "model-a",
    effort: "high",
  });
});
it("keeps model-default provider thinking dynamic across save and reopen", async () => {
  const f = fixture();
  await f.provider.check();
  f.provider.saveDefaults({ model: "", effort: "high" });
  const onClose = vi.fn();
  const view = render(<f.tabs.ProviderDialogBody onClose={onClose} />);
  const user = userEvent.setup();

  expect(screen.getByLabelText("Default thinking")).toHaveTextContent("High");
  await user.click(screen.getByLabelText("Default thinking"));
  await user.click(
    await screen.findByRole("option", { name: "Codex default (Low)" }),
  );
  await user.click(screen.getByRole("button", { name: "Save defaults" }));

  expect(onClose).toHaveBeenCalledOnce();
  expect(
    JSON.parse(
      localStorage.getItem("buzz.codex.provider-defaults.v1") ?? "null",
    ),
  ).toMatchObject({ effort: "" });

  view.unmount();
  const reopened = fixture();
  render(<reopened.tabs.ProviderDialogBody onClose={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Default thinking")).toBeEnabled(),
  );
  expect(screen.getByLabelText("Default thinking")).toHaveTextContent(
    "Codex default (Low)",
  );
});
it("loads model/effort choices and saves only after a validated workspace, holding the saving state", async () => {
  const f = fixture();
  const saving = deferred<void>();
  const save = vi.fn(() => saving.promise);
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  expect(
    screen.getByText("Runtime diagnostics").closest("details"),
  ).not.toHaveAttribute("open");
  expect(
    screen.getByText(
      "Mention this agent in a channel to start a conversation.",
    ),
  ).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
  expect(screen.queryByText("Model A description.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Thinking")).toHaveTextContent(
    "Codex default (Low)",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  expect(
    await screen.findByRole("option", { name: "Codex default (Model A)" }),
  ).toHaveAccessibleDescription("Following the provider's model default");
  const model = await screen.findByRole("option", { name: "Model B" });
  expect(model).toHaveAccessibleDescription("Model B description.");
  await user.click(model);
  expect(screen.getByLabelText("Thinking")).toHaveTextContent("Medium");
  await user.click(screen.getByLabelText("Thinking"));
  expect(
    screen.queryByRole("option", { name: "High" }),
  ).not.toBeInTheDocument();
  await userEvent.setup().keyboard("{Escape}");
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "relative" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "/tmp/codex" },
  });
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Custom instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  try {
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        ...defaults,
        model: "model-b",
        effort: "medium",
        workspace: "/tmp/codex",
        instructions: "Custom instructions",
      }),
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByLabelText("Workspace")).toBeDisabled();
  } finally {
    saving.resolve();
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(f.processes[0]?.end).toHaveBeenCalled();
});
it("renders provider, model, and thinking as direct settings inputs", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  const saved = { ...defaults, model: "model-b", effort: "medium" };
  render(
    <f.tabs.SettingsTab
      {...f.props(saved, save)}
      settingsHost={{
        typeControl: () => <p>Type control</p>,
      }}
    />,
  );
  const user = userEvent.setup();
  const typeControl = screen.getByText("Type control");
  const modelControl = await screen.findByRole("combobox", { name: "Model" });
  const thinkingControl = screen.getByLabelText("Thinking");
  expect(
    typeControl.compareDocumentPosition(modelControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    modelControl.compareDocumentPosition(thinkingControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(modelControl).toHaveTextContent("Model B");
  expect(thinkingControl).toHaveTextContent("Medium");
  await user.click(modelControl);
  await user.click(
    await screen.findByRole("option", { name: "Codex default (Model A)" }),
  );
  expect(screen.getByLabelText("Thinking")).toHaveTextContent(
    "Codex default (Low)",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({ ...saved, model: "", effort: "" });
});

it("keeps settings editable while a provider change waits for Save", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  render(
    <f.tabs.SettingsTab
      {...f.props(defaults, save)}
      settingsHost={{
        pendingSave: async () => {},
      }}
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(defaults);
});
/** Holds the next spawn until `release`, returning its process, which the
 * view has not seen yet. */
async function holdSpawn(f: ReturnType<typeof fixture>) {
  const late = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  if (!original) throw new Error("Missing spawn fixture");
  let process!: Awaited<ReturnType<typeof f.spawn>>;
  f.spawn.mockImplementationOnce(async (id, options) => {
    process = await original(id, options);
    started.resolve();
    return late.promise;
  });
  return {
    started: started.promise,
    release: () => late.resolve(process),
    process: () => process,
  };
}
it("preserves unavailable saved choices and closes a late provider check on dispose", async () => {
  const f = fixture();
  const saved = {
    ...defaults,
    model: "retired-model",
    effort: "high",
    workspace: "/tmp/codex",
  };
  const view = render(<f.tabs.SettingsTab {...f.props(saved)} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "retired-model",
    ),
  );
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High (unavailable)",
  );
  view.unmount();
  const held = await holdSpawn(f);
  const pending = f.provider.check();
  await held.started;
  expect(f.provider.snapshot()).toMatchObject({
    readiness: "ready",
    checking: true,
  });
  f.provider.dispose();
  held.release();
  await waitFor(() => expect(held.process().end).toHaveBeenCalled());
  await pending;
});

it("starts a new agent from a model and instructions, keeping the rest", async () => {
  const f = fixture();
  const config = {
    ...defaults,
    model: "model-a",
    effort: "high",
    workspace: "/work",
    scope: "channel" as const,
  };
  const onChange = vi.fn();
  render(
    <>
      <f.tabs.Create config={config} onChange={onChange} disabled={false} />
      <MenuRoot>
        <MenuTrigger render={<Button>Models</Button>} />
        <MenuPopup>
          <f.tabs.CreateModelMenu
            config={config}
            onChange={onChange}
            disabled={false}
            requestCustomModel={vi.fn()}
          />
        </MenuPopup>
      </MenuRoot>
    </>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Models" }));
  await user.click(
    await screen.findByRole("menuitemradio", {
      name: "Model B Model B description.",
    }),
  );
  // The new model's own effort replaces the old one.
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "model-b",
    effort: "medium",
  });
  expect(f.tabs.createModelLabel({ ...config, model: "model-b" })).toBe(
    "Model B",
  );
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Triage.",
  });
  await user.click(screen.getByRole("button", { name: "Models" }));
  await user.click(
    await screen.findByRole("menuitemradio", {
      name: "Codex default (Model A) Following the provider's model default",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "",
    effort: "",
  });
});

it("keeps a new agent on the default when the catalog fails", async () => {
  const f = fixture();
  f.spawn.mockRejectedValueOnce(new Error("no codex"));
  const onChange = vi.fn();
  render(
    <MenuRoot>
      <MenuTrigger render={<Button>Models</Button>} />
      <MenuPopup>
        <f.tabs.CreateModelMenu
          config={{ ...defaults, effort: "high" }}
          onChange={onChange}
          disabled={false}
          requestCustomModel={vi.fn()}
        />
      </MenuPopup>
    </MenuRoot>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Models" }));
  await waitFor(() => expect(f.spawn).toHaveBeenCalled());
  expect(
    screen.queryByRole("menuitem", { name: /Custom model/ }),
  ).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

it("shows the default workspace and restores it when the field is cleared", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  expect(screen.getByLabelText("Workspace")).toHaveValue("~/.buzz");
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Test instructions" },
  });
  const expected = { ...defaults, instructions: "Test instructions" };
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
  await waitFor(() => expect(screen.getByLabelText("Workspace")).toBeEnabled());
  save.mockClear();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
});
