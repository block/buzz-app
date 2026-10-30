// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { BestieChooser } from "./BestieChooser";

// PinnedBestie covers the real shared Select. This file keeps that control's
// contract small so it can hold the chooser's pending and failure lifecycles.
vi.mock("../../shared/design-system/ui/Select", () => ({
  Select: ({
    disabled,
    onValueChange,
  }: {
    disabled?: boolean;
    onValueChange(value: string): void;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onValueChange(pollen)}
    >
      Pick Pollen
    </button>
  ),
}));
vi.mock("../agents/AgentCreateDialog", () => ({
  AgentCreateDialog: ({
    onCreated,
  }: {
    onCreated(agent: { pubkey: string }): void;
  }) => (
    <button type="button" onClick={() => onCreated({ pubkey: pollen })}>
      Finish creation
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const pollen = "b".repeat(64);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(write: (agent: string | null) => Promise<void>) {
  let selectable = [{ pubkey: pollen, name: "Pollen", managed: true }];
  const makeSnapshot = () =>
    ({
      status: "ready" as const,
      complete: true,
      pending: false,
      selectable,
      identities: selectable,
      definitions: [],
      archives: { status: "ready" as const, archived: [] },
      templates: {
        status: "ready" as const,
        complete: true,
        pending: false,
        identities: selectable,
        definitions: [],
      },
    }) as const;
  let choices = makeSnapshot();
  const session = {
    mainAgent: { read: async () => undefined, write: vi.fn(write) },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
      refresh: vi.fn(async () => {}),
    },
  } as unknown as RelaySession;
  const agents = {
    subscribe: () => () => {},
    snapshot: () => undefined,
    types: () => empty,
  } as unknown as Agents;
  return {
    session,
    removeChoice: () => {
      selectable = [];
      choices = makeSnapshot();
    },
    mount: () =>
      render(
        <BestieChooser
          session={session}
          scope="community:viewer"
          agents={agents}
        />,
      ),
  };
}

const empty: readonly never[] = [];

async function selectPollen() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Pick Pollen" }));
  return user;
}

it("holds the selected agent disabled until the account save settles", async () => {
  const gate = deferred();
  const f = fixture(async () => gate.promise);
  f.mount();
  await selectPollen();
  expect(f.session.mainAgent?.write).toHaveBeenCalledWith(pollen);
  expect(screen.getByRole("button", { name: "Pick Pollen" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Saving your Bestie…");
  gate.resolve();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Pick Pollen" })).toBeEnabled(),
  );
});

it("keeps the chooser available when the account save fails", async () => {
  const f = fixture(async () => {
    throw new Error("save failed");
  });
  f.mount();
  await selectPollen();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  expect(screen.getByRole("button", { name: "Pick Pollen" })).toBeEnabled();
});

it("rejects a choice that became stale before selection", async () => {
  const f = fixture(async () => {});
  f.mount();
  const user = userEvent.setup();
  f.removeChoice();
  await user.click(screen.getByRole("button", { name: "Pick Pollen" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That agent is no longer available. Choose another.",
  );
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
});

it("retries the handoff after agent creation refresh fails", async () => {
  const f = fixture(async () => {});
  vi.mocked(f.session.agentChoices.refresh)
    .mockRejectedValueOnce(new Error("inventory failed"))
    .mockResolvedValue(undefined);
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await user.click(screen.getByRole("button", { name: "Finish creation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "inventory failed",
  );
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(f.session.mainAgent?.write).toHaveBeenCalledWith(pollen),
  );
});
