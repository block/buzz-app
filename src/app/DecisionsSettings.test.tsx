// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentsSnapshot } from "../features/agents/service";
import type { DecisionBackend } from "../features/decisions/service";
import { DecisionsSettings } from "./DecisionsSettings";

afterEach(cleanup);

/** Agents as far as the card uses it, with a key store that can fail. */
function fake(
  status: AgentsSnapshot["status"] = "ready",
  classifierKey: AgentsSnapshot["classifierKey"] = "missing",
) {
  let state: AgentsSnapshot = {
    status,
    classifier: "unavailable",
    classifierKey,
    agents: [],
    running: [],
    teams: [],
  };
  const listeners = new Set<() => void>();
  const set = (classifierKey: AgentsSnapshot["classifierKey"]) => {
    state = { ...state, classifierKey };
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setClassifierKey: vi.fn(async (_key: string) => set("saved")),
    clearClassifierKey: vi.fn(async () => set("missing")),
  };
}

/** The device's backend, as far as the card uses it. */
function backends(initial: DecisionBackend = "typesafe") {
  let backend = initial;
  const listeners = new Set<() => void>();
  return {
    backend: () => backend,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setBackend: vi.fn((next: DecisionBackend) => {
      backend = next;
      for (const listener of listeners) listener();
    }),
  };
}
/** The card on the `typesafe` backend, where the key form shows. */
function OnTypesafe(
  props: Omit<Parameters<typeof DecisionsSettings>[0], "decisions"> & {
    decisions?: ReturnType<typeof backends>;
  },
) {
  return <DecisionsSettings decisions={backends()} {...props} />;
}

it("defaults to Block, asks no key there, and asks for one on TypeSafe", async () => {
  const user = userEvent.setup();
  const decisions = backends("block");
  render(
    <DecisionsSettings
      decisions={decisions}
      agents={fake()}
      active={() => true}
    />,
  );
  expect(screen.getByRole("radio", { name: /Block Jev/ })).toBeChecked();
  expect(screen.queryByLabelText("TypeSafe API key")).not.toBeInTheDocument();
  expect(screen.getByText(/kgoose\.sqprod\.co/)).toHaveTextContent(
    /counts the cost/,
  );
  await user.click(screen.getByRole("radio", { name: /Block OpenAI/ }));
  expect(decisions.setBackend).toHaveBeenLastCalledWith("block-openai");
  await user.click(screen.getByRole("radio", { name: /TypeSafe/ }));
  expect(decisions.setBackend).toHaveBeenLastCalledWith("typesafe");
  expect(screen.getByLabelText("TypeSafe API key")).toBeInTheDocument();
  expect(screen.getByText(/api\.typesafe\.ai/)).toBeInTheDocument();
});

it("does not change the backend while the card is inactive", async () => {
  const user = userEvent.setup();
  const decisions = backends("block");
  render(
    <DecisionsSettings
      decisions={decisions}
      agents={fake()}
      active={() => false}
    />,
  );
  await user.click(screen.getByRole("radio", { name: /TypeSafe/ }));
  expect(decisions.setBackend).not.toHaveBeenCalled();
});

it("asks for the desktop app in the browser", () => {
  render(<OnTypesafe agents={fake("unavailable")} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByLabelText("TypeSafe API key")).not.toBeInTheDocument();
});

it("saves a key without showing it again, and removes it", async () => {
  const user = userEvent.setup();
  const agents = fake();
  render(<OnTypesafe agents={agents} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("No TypeSafe key");
  const input = screen.getByLabelText("TypeSafe API key");
  expect(input).toHaveAttribute("type", "password");
  expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  await user.type(input, "  tk-secret  ");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(agents.setClassifierKey).toHaveBeenCalledWith("tk-secret");
  expect(input).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent(
    "A TypeSafe key is saved",
  );
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(agents.clearClassifierKey).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("No TypeSafe key");
});

it("keeps the typed key and shows why a save failed", async () => {
  const user = userEvent.setup();
  const agents = fake();
  agents.setClassifierKey.mockRejectedValueOnce(
    new Error("That does not look like a TypeSafe API key"),
  );
  render(<OnTypesafe agents={agents} active={() => true} />);
  await user.type(screen.getByLabelText("TypeSafe API key"), "bad key");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not look like",
  );
  expect(screen.getByLabelText("TypeSafe API key")).toHaveValue("bad key");
});

it("says what each classified event sends to TypeSafe", () => {
  render(<OnTypesafe agents={fake()} active={() => true} />);
  expect(screen.getByText(/api\.typesafe\.ai/)).toHaveTextContent(
    /whole event.*display name.*channel name.*600 characters.*mentions.*private channels/,
  );
});

it("does not call a key missing until its status is read, or when it cannot be", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <OnTypesafe agents={fake("ready", "checking")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Checking");
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  const unreadable = fake("ready", "unreadable");
  rerender(<OnTypesafe agents={unreadable} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("could not be read");
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(unreadable.clearClassifierKey).toHaveBeenCalledOnce();
  rerender(
    <OnTypesafe agents={fake("ready", "refused")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "TypeSafe refused the saved key",
  );
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
});

it.each([
  [true, /this Mac's Keychain, where only Buzz can read it/],
  [false, /Other programs you run, agent shells included, can read it there/],
])("says who can read the key (Keychain: %s)", (apple, text) => {
  render(<OnTypesafe agents={fake()} active={() => true} apple={apple} />);
  expect(screen.getByText(text)).toBeInTheDocument();
});
