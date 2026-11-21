// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSaveState } from "../../features/agents/AgentSaveButton";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { AgentEnvironment } from "./AgentEnvironment";
import { AgentTabs } from "./AgentTabs";

const AGENT = "ab".repeat(32);

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => native.invoke(...args),
}));

let names: string[];
const restartAgent = vi.fn(async () => {});
beforeEach(() => {
  names = ["SAVED_KEY"];
  restartAgent.mockReset().mockResolvedValue(undefined);
  native.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "agent_env_status") return { names };
    if (command === "agent_env_set") {
      const rows = (args as { rows: { name: string }[] }).rows;
      if (rows.some((row) => row.name === "GOOSE_MODEL"))
        throw "GOOSE_MODEL chooses a model, provider or endpoint.";
      names = rows.map((row) => row.name);
    }
    return undefined;
  });
});
afterEach(cleanup);

const calls = (command: string) =>
  native.invoke.mock.calls.filter(([name]) => name === command);
const newName = () =>
  screen
    .getAllByRole("textbox", { name: "Variable name" })
    .at(-1) as HTMLElement;

it("adding a row keeps the hidden saved values", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(await screen.findByRole("button", { name: "Add variable" }));
  await user.type(newName(), "FOO");
  await user.type(screen.getByLabelText("Value of FOO"), "bar");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(calls("agent_env_status")[0]?.[1]).toEqual({ agent: AGENT });
  expect(calls("agent_env_set")[0]?.[1]).toEqual({
    agent: AGENT,
    rows: [
      { name: "SAVED_KEY", value: null },
      { name: "FOO", value: "bar" },
    ],
  });
  await waitFor(() => expect(calls("agent_env_status")).toHaveLength(2));
});

it("a rejected save shows why", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(await screen.findByRole("button", { name: "Add variable" }));
  await user.type(newName(), "GOOSE_MODEL");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("GOOSE_MODEL");
});

it("restarting the agent asks first, then stops only its processes", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(
    await screen.findByRole("button", { name: "Restart agent" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(restartAgent).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Restart agent" }));
  await user.click(screen.getByRole("button", { name: "Restart" }));
  await waitFor(() => expect(restartAgent).toHaveBeenCalledOnce());
  expect(calls("update_restart")).toHaveLength(0);
});

it("shows why a restart was refused", async () => {
  restartAgent.mockRejectedValueOnce(
    new Error("Echo is answering; restart it when it finishes"),
  );
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(
    await screen.findByRole("button", { name: "Restart agent" }),
  );
  await user.click(screen.getByRole("button", { name: "Restart" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Echo is answering; restart it when it finishes",
  );
});

it("offers no restart while a save is still being written", async () => {
  const user = userEvent.setup();
  let finish = () => {};
  native.invoke.mockImplementation(async (command) => {
    if (command === "agent_env_status") return { names };
    if (command === "agent_env_set")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return undefined;
  });
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.type(await screen.findByLabelText("Value of SAVED_KEY"), "new");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await user.click(screen.getByRole("button", { name: "Restart agent" }));
  expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  finish();
  await waitFor(() =>
    expect(screen.getByLabelText("Value of SAVED_KEY")).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Restart agent" }));
  await user.click(screen.getByRole("button", { name: "Restart" }));
  await waitFor(() => expect(restartAgent).toHaveBeenCalledOnce());
});

it("locks the list until a restart finishes", async () => {
  const user = userEvent.setup();
  let finish = () => {};
  restartAgent.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(
    await screen.findByRole("button", { name: "Restart agent" }),
  );
  await user.click(screen.getByRole("button", { name: "Restart" }));
  const value = screen.getByLabelText("Value of SAVED_KEY");
  try {
    expect(value).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add variable" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove SAVED_KEY" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.type(value, "new");
    expect(value).toHaveValue("");
  } finally {
    finish();
  }
  await waitFor(() => expect(value).toBeEnabled());
  await user.type(value, "new");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls("agent_env_set")).toHaveLength(1));
});

it("removing a saved row deletes it on save", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.click(
    await screen.findByRole("button", { name: "Remove SAVED_KEY" }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(calls("agent_env_set")[0]?.[1]).toEqual({ agent: AGENT, rows: [] });
});

it("locks the list while a save runs, so no edit is lost when it finishes", async () => {
  const user = userEvent.setup();
  let finish = () => {};
  native.invoke.mockImplementation(async (command) => {
    if (command === "agent_env_status") return { names };
    if (command === "agent_env_set")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return undefined;
  });
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  await user.type(await screen.findByLabelText("Value of SAVED_KEY"), "new");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByLabelText("Value of SAVED_KEY")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add variable" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Remove SAVED_KEY" }),
  ).toBeDisabled();
  const saveButton = screen.getByRole("button", { name: "Save" });
  expect(saveButton).toHaveAttribute("aria-disabled", "true");
  expect(saveButton).toHaveFocus();
  finish();
  await waitFor(() =>
    expect(screen.getByLabelText("Value of SAVED_KEY")).toBeEnabled(),
  );
  expect(screen.getByRole("button", { name: "Add variable" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
});

it("offers Retry for a list it cannot read, never an empty one", async () => {
  const user = userEvent.setup();
  let readable = false;
  native.invoke.mockImplementation(async (command) => {
    if (command !== "agent_env_status") return undefined;
    if (!readable) throw "The credential store is locked";
    return { names };
  });
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The credential store is locked",
  );
  expect(screen.queryByRole("button", { name: "Add variable" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  readable = true;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByLabelText("Value of SAVED_KEY")).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("tells the agent's page about unsaved edits, through the save and its reload", async () => {
  const user = userEvent.setup();
  const reports: { dirty: boolean; saving: boolean }[] = [];
  let finishSave = () => {};
  let finishReload = () => {};
  let reloads = 0;
  native.invoke.mockImplementation(async (command) => {
    if (command === "agent_env_status") {
      if (reloads++ > 0)
        await new Promise<void>((resolve) => {
          finishReload = resolve;
        });
      return { names };
    }
    if (command === "agent_env_set")
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
    return undefined;
  });
  render(
    <AgentSaveState value={(state) => state && reports.push(state)}>
      <AgentEnvironment agent={AGENT} restartAgent={restartAgent} />
    </AgentSaveState>,
  );
  const last = () => reports.at(-1);
  await user.type(await screen.findByLabelText("Value of SAVED_KEY"), "new");
  expect(last()).toEqual({ dirty: true, saving: false });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(last()).toEqual({ dirty: true, saving: true });
  finishSave();
  await waitFor(() => expect(reloads).toBe(2));
  expect(last()?.saving).toBe(true);
  finishReload();
  await waitFor(() => expect(last()).toEqual({ dirty: false, saving: false }));
});

it("blocks leaving Settings while the environment variables have unsaved edits", async () => {
  native.invoke
    .mockReset()
    .mockImplementation(async (command) =>
      command === "agent_env_status" ? { names: [] } : undefined,
    );
  const user = userEvent.setup();
  const agent = {
    key: AGENT,
    pubkey: AGENT,
    name: "Ada",
    place: "here",
    type: "test",
    owner: "c".repeat(64),
    relay: "wss://example.com",
    config: {},
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const type = {
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: ({ settingsContent }: { settingsContent?: unknown }) => (
          <>{settingsContent}</>
        ),
      },
    ],
  } as unknown as RegisteredAgentType;
  const agents = {
    subscribe: () => () => {},
    classifier: () => "unavailable",
    memberships: () => [],
    configHistory: () => undefined,
    addedTabs: () => [],
    registerTab: () => {},
    controlAttention: () => {},
  } as unknown as Agents;
  render(
    <AgentTabs
      agents={agents}
      agent={agent}
      type={type}
      channels={[]}
      settingsHost={{}}
      memories={undefined}
      settingsContent={
        <AgentEnvironment agent={AGENT} restartAgent={restartAgent} />
      }
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Add variable" }));
  await user.type(
    screen
      .getAllByRole("textbox", { name: "Variable name" })
      .at(-1) as HTMLElement,
    "FOO",
  );
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    screen.getAllByRole("textbox", { name: "Variable name" }).at(-1),
  ).toHaveValue("FOO");
  expect(native.invoke).not.toHaveBeenCalledWith(
    "agent_env_set",
    expect.anything(),
  );
});

it("offers no restart while the list has unsaved edits", async () => {
  const user = userEvent.setup();
  render(<AgentEnvironment agent={AGENT} restartAgent={restartAgent} />);
  const restart = await screen.findByRole("button", { name: "Restart agent" });
  expect(restart).not.toHaveAttribute("aria-disabled", "true");
  await user.type(screen.getByLabelText("Value of SAVED_KEY"), "new");
  expect(restart).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("Save your changes first.")).toBeInTheDocument();
  await user.click(restart);
  expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
});
