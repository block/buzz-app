// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import type { RelaySession } from "../relay/session";
import type { PresenceStatus } from "../presence/presence";
import { AgentChoice, agentAdmission } from "./AgentChoice";

afterEach(cleanup);

it("reloads the selected agent after the connection clears the library", async () => {
  const pubkey = "a".repeat(64);
  const read = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Selected agent" }],
  }));
  const library = createAgentLibrary(read);
  const session = {
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
  } as RelaySession;
  const view = render(
    <StrictMode>
      <AgentChoice session={session} value={pubkey} onChange={vi.fn()} />
    </StrictMode>,
  );
  expect(
    await screen.findByRole("button", { name: "Change agent: Selected agent" }),
  ).toHaveTextContent("Selected agent");
  await act(async () => library.clear());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(
    await screen.findByRole("button", { name: "Change agent: Selected agent" }),
  ).toHaveTextContent("Selected agent");
  view.unmount();
  library.dispose();
});

it("opens the avatar menu and changes the chosen agent without submitting", async () => {
  const user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Fizz" }],
  }));
  const onChange = vi.fn(),
    onSubmit = vi.fn();
  render(
    <form onSubmit={onSubmit}>
      <AgentChoice
        session={
          {
            agentChoices: createAgentChoices({
              scope: "test",
              library: library.queries,
              signal: new AbortController().signal,
            }),
          } as RelaySession
        }
        value=""
        onChange={onChange}
      />
    </form>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Choose an agent" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Fizz" }));
  expect(onChange).toHaveBeenCalledWith(pubkey, expect.anything());
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  library.dispose();
});

it("names known agent presence on the selected trigger and choices", async () => {
  const user = userEvent.setup();
  const pubkey = "a".repeat(64);
  let status: PresenceStatus = "unknown";
  const listeners = new Set<() => void>();
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Fizz" }],
  }));
  const session = {
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
    presence: {
      status: () => status,
      limited: () => false,
      subscribe: (_key: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  render(<AgentChoice session={session} value={pubkey} onChange={vi.fn()} />);
  expect(
    await screen.findByRole("button", { name: "Change agent: Fizz" }),
  ).toBeTruthy();
  act(() => {
    status = "away";
    for (const listener of listeners) listener();
  });
  const trigger = screen.getByRole("button", {
    name: "Change agent: Fizz, away",
  });
  await user.click(trigger);
  expect(
    await screen.findByRole("menuitemradio", { name: "Fizz, away" }),
  ).toBeTruthy();
  act(() => {
    status = "unknown";
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "Change agent: Fizz" }),
  ).toBeTruthy();
  expect(screen.getByRole("menuitemradio", { name: "Fizz" })).toBeTruthy();
  library.dispose();
});

it("distinguishes session admission from parent-channel admission", () => {
  const member = "a".repeat(64);
  const outside = "b".repeat(64);
  expect(agentAdmission(member, undefined, [member], [])).toBeUndefined();
  expect(agentAdmission(outside, undefined, [member], [outside])).toBe(
    "session",
  );
  expect(agentAdmission(outside, undefined, [member], [])).toBe(
    "session-and-channel",
  );
});
