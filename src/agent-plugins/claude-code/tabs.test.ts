// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentType } from "../../features/agents2/service";
import type { HostProcessOptions } from "../../features/host/service";
import { apply, inject } from "./index";
import { type Config, DEFAULT_CONFIG } from "./runtime";

afterEach(cleanup);

const agent = (config: Config = DEFAULT_CONFIG) =>
  ({
    pubkey: "c".repeat(64),
    name: "Claude",
    type: "buzz.claude-code/claude-code",
    owner: "a".repeat(64),
    config,
  }) as Agent<Config>;

/** Applies the plugin to a stand-in context; its `claude` is signed in. */
function installed() {
  let type: AgentType<Config> | undefined;
  const spawn = vi.fn(async (_id: string, options: HostProcessOptions = {}) => {
    const args = (options.args ?? []).join(" ");
    queueMicrotask(() =>
      options.onStdout?.(
        args === "--version"
          ? "2.1.292 (Claude Code)\n"
          : args === "auth status --json"
            ? '{"loggedIn":true,"email":"me@example.com"}'
            : "",
      ),
    );
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(0), 0),
      ),
    };
  });
  const ctx = {
    react: React,
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { spawn, request: vi.fn() },
    relay: { snapshot: () => ({ status: "signed-out" }) },
    agents2: {
      register: (registered: AgentType<Config>) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [] }),
      subscribe: () => () => undefined,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  if (!type) throw new Error("no type registered");
  return { type, spawn };
}

it("is an installable agent type using the host's React", () => {
  expect(inject).toEqual(["react", "agents2", "host", "relay"]);
  const { type } = installed();
  expect(type).toMatchObject({ id: "claude-code", title: "Claude Code" });
  expect(type.defaults()).toEqual({ config: DEFAULT_CONFIG });
  expect(type.summary?.(agent({ ...DEFAULT_CONFIG, model: "opus" }))).toBe(
    "opus",
  );
  expect(type.tabs?.map((tab) => tab.title)).toEqual(["Claude", "Settings"]);
});

it("shows that Claude Code is ready and that nothing is running yet", async () => {
  const { type } = installed();
  const Claude = type.tabs?.[0]?.component;
  if (!Claude) throw new Error("no tab");
  render(React.createElement(Claude, { agent: agent(), save: vi.fn() }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude Code 2.1.292 is ready (me@example.com).",
    ),
  );
  expect(
    screen.getByText(/None\. A conversation's session starts/),
  ).toBeVisible();
});

it("saves settings as one config and warns before answering anyone", async () => {
  const { type } = installed();
  const Settings = type.tabs?.[1]?.component;
  if (!Settings) throw new Error("no tab");
  const save = vi.fn(async () => undefined);
  render(React.createElement(Settings, { agent: agent(), save }));
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("Model"), "sonnet");
  await user.selectOptions(screen.getByLabelText("Answers"), "anyone");
  expect(screen.getByText(/with no approval step/)).toBeVisible();
  await user.clear(screen.getByLabelText("Workspace"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "sonnet",
    respondTo: "anyone",
    workspace: "~/.buzz",
  });
});
