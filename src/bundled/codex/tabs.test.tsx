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
import { defaults, type Config } from "./config";
import { createTabs } from "./tabs";
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
});
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}
function fixture(signedIn = true) {
  const login = deferred<number | null>();
  const processes: { end: ReturnType<typeof vi.fn> }[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    const exit = deferred<number | null>();
    if (_id === "login")
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => login.resolve(null),
        exited: login.promise.then((code) => {
          if (code === 0) signedIn = true;
          return code;
        }),
      };
    const process = {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.id == null) return;
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
  const runtime = new CodexRuntime(spawn, () => undefined, {} as Storage);
  const tabs = createTabs(spawn, runtime);
  const props = (settings = defaults, save = vi.fn(async () => {})) =>
    ({
      agent: { pubkey: "a".repeat(64), config: settings },
      save,
    }) as unknown as AgentViewProps<Config>;
  const Create = (props: React.ComponentProps<typeof tabs.Create>) => (
    <>
      <tabs.Create {...props} />
      <tabs.CreateModel {...props} />
    </>
  );
  return { spawn, processes, tabs, props, Create, login };
}
it("loads model/effort choices and saves only after a validated workspace, holding the saving state", async () => {
  const f = fixture();
  const saving = deferred<void>();
  const save = vi.fn(() => saving.promise);
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "Codex default · Model A",
    ),
  );
  await choose("Model", "Model B");
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Medium");
  await userEvent.setup().click(thinking);
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
it("preserves unavailable saved choices and closes a process returned after unmount", async () => {
  const f = fixture();
  const saved = {
    ...defaults,
    model: "retired-model",
    effort: "high",
    workspace: "/tmp/codex",
  };
  const view = render(<f.tabs.SettingsTab {...f.props(saved)} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "retired-model",
    ),
  );
  await waitFor(() => expect(f.processes[0]?.end).toHaveBeenCalled());
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High (unavailable)",
  );
  view.unmount();
  const held = await holdSpawn(f);
  const pending = render(<f.tabs.CodexTab {...f.props(saved)} />);
  await held.started;
  pending.unmount();
  held.release();
  await waitFor(() => expect(held.process().end).toHaveBeenCalled());
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
  render(<f.Create config={config} onChange={onChange} disabled={false} />);
  await choose("Model", "Model B");
  // The new model's own effort replaces the old one.
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "model-b",
    effort: "medium",
  });
  fireEvent.change(screen.getByLabelText("Describe what I should do"), {
    target: { value: "Triage." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Triage.",
  });
  await choose("Model", "Model A");
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "model-a",
    effort: "low",
  });
});

it("retains a saved custom model and offers retry when discovery fails", async () => {
  const f = fixture();
  f.spawn.mockRejectedValueOnce(new Error("no codex"));
  const onChange = vi.fn();
  render(
    <f.Create
      config={{ ...defaults, model: "gpt-custom" }}
      onChange={onChange}
      disabled={false}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("no codex");
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
    "gpt-custom",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Try again" }));
  await choose("Model", "Model A");
  expect(onChange).toHaveBeenLastCalledWith({
    ...defaults,
    model: "model-a",
    effort: "low",
  });
});

it("checks the catalog for a new agent only while its view is mounted", async () => {
  const f = fixture();
  const held = await holdSpawn(f);
  expect(f.spawn).not.toHaveBeenCalled();
  const view = render(
    <f.Create config={defaults} onChange={vi.fn()} disabled={false} />,
  );
  await held.started;
  view.unmount();
  held.release();
  await waitFor(() => expect(held.process().end).toHaveBeenCalled());
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

it("shows a catalog failure in the creation row and retries before choosing a model", async () => {
  const f = fixture();
  f.spawn.mockRejectedValueOnce(new Error("Catalog unavailable"));
  const onChange = vi.fn();
  render(
    <f.tabs.CreateModel
      config={defaults}
      onChange={onChange}
      disabled={false}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Catalog unavailable",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await choose("Model", "Model B");
  expect(onChange).toHaveBeenCalledWith({
    ...defaults,
    model: "model-b",
    effort: "medium",
  });
});

it("replaces sign-in with available models after Codex login succeeds", async () => {
  const f = fixture(false);
  render(
    <>
      <f.tabs.CreateModel
        config={defaults}
        disabled={false}
        onChange={vi.fn()}
      />
      <f.tabs.CreateModel
        config={defaults}
        disabled={false}
        onChange={vi.fn()}
      />
    </>,
  );
  const buttons = await screen.findAllByRole("button", { name: "Sign in" });
  if (!buttons[0]) throw new Error("Missing sign-in");
  fireEvent.click(buttons[0]);
  expect(
    screen.queryByRole("combobox", { name: "Model" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Cancel" })).toBeVisible();
  f.login.resolve(0);
  await waitFor(() =>
    expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(2),
  );
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
});

it("keeps sign-in available after a failed Codex login without showing models", async () => {
  const f = fixture(false);
  render(
    <f.tabs.CreateModel
      config={defaults}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  await screen.findByRole("button", { name: "Cancel" });
  f.login.resolve(1);
  expect(await screen.findByRole("log")).toHaveTextContent(
    "Sign-in did not finish",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(
    screen.queryByRole("combobox", { name: "Model" }),
  ).not.toBeInTheDocument();
});
