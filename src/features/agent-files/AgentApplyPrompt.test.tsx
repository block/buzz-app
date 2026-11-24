// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentApplyPrompt } from "./AgentApplyPrompt";
import type { AgentFileHost } from "./apply";
import type { AgentCall } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const handlers = new Map<string, (event: { payload: unknown }) => void>();
beforeEach(() => {
  handlers.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    handlers.set(name, handler as (event: { payload: unknown }) => void);
    return () => handlers.delete(name);
  });
});
afterEach(cleanup);

const PUBKEY = "a".repeat(64);
const TYPE = "plugin/claude";
const agent = {
  key: PUBKEY,
  pubkey: PUBKEY,
  relay: "wss://relay.example",
  owner: "b".repeat(64),
  type: TYPE,
  name: "Triage Bot",
  place: "here",
  config: { instructions: "You are Triage Bot.", model: "m" },
  attention: {},
};
const save = vi.fn(async () => undefined);
const host = {
  agents: {
    snapshot: () => ({ status: "ready", agents: [agent] }),
    types: () => [
      {
        key: TYPE,
        syncedSettings: {
          schema: { model: "string" },
          withSynced: (config: object, settings: object) => ({
            ...config,
            ...settings,
          }),
        },
      },
    ],
    save,
  },
  relay: () => ({
    relayAuthor: "c".repeat(64),
    viewer: "b".repeat(64),
    readRemote: async () => [],
    memberAdministration: {},
  }),
} as unknown as AgentFileHost;

const call = async (payload: AgentCall) => {
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("credential_agent_listen", {
      mounted: true,
    }),
  );
  act(() => handlers.get("credential-agent-request")?.({ payload }));
};
const answer = (id: string) =>
  vi.waitFor(() => {
    const found = vi
      .mocked(invoke)
      .mock.calls.find(
        ([name, args]) =>
          name === "credential_agent_answer" &&
          (args as { id: string }).id === id,
      );
    expect(found).toBeDefined();
    return found?.[1] as {
      result: string | null;
      code: string | null;
      message: string | null;
    };
  });

it("answers a read at once, and applies a change only once approved", async () => {
  render(<AgentApplyPrompt host={host} />);
  await call({
    id: "r",
    method: "agent_read",
    params: [PUBKEY],
    expiresIn: 10,
  });
  const read = JSON.parse((await answer("r")).result ?? "") as {
    revision: string;
    document: { instructions: string };
  };
  expect(read.document.instructions).toBe("You are Triage Bot.");
  expect(screen.queryByRole("alertdialog")).toBeNull();

  const document = JSON.stringify({
    ...read.document,
    instructions: "You triage pages.",
  });
  await call({
    id: "a",
    method: "agent_apply",
    params: [PUBKEY, document, read.revision, "{}"],
    expiresIn: 120,
  });
  await screen.findByText("instructions");
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(await answer("a")).toMatchObject({ code: null });
  expect(save).toHaveBeenCalledWith(PUBKEY, {
    config: { instructions: "You triage pages.", model: "m" },
  });
});

it("refuses a change based on a stale read", async () => {
  render(<AgentApplyPrompt host={host} />);
  await call({
    id: "r",
    method: "agent_read",
    params: [PUBKEY],
    expiresIn: 10,
  });
  const { document } = JSON.parse((await answer("r")).result ?? "") as {
    document: object;
  };
  await call({
    id: "a",
    method: "agent_apply",
    params: [PUBKEY, JSON.stringify(document), "stale", "{}"],
    expiresIn: 120,
  });
  expect(await answer("a")).toMatchObject({ code: "conflict" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
