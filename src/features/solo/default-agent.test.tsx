// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { setDefaultAgent, useDefaultAgent } from "./default-agent";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("choosing a default updates new-chat routing only in its account/community scope", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ scope }: { scope: string }) {
    return (
      <output aria-label={scope}>
        {useDefaultAgent(session, scope)?.name}
      </output>
    );
  }
  render(
    <>
      <Selection scope="one" />
      <Selection scope="two" />
    </>,
  );
  expect(screen.getByLabelText("one").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "b".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("Second");
  expect(screen.getByLabelText("two").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "d".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("First");
});

it("waits for complete fallback and settled archive evidence, but honors an available explicit choice", () => {
  const relay = { pubkey: "a".repeat(64), name: "Relay", managed: false };
  const local = { pubkey: "b".repeat(64), name: "Local", managed: true };
  let choices = {
    status: "ready",
    complete: false,
    pending: true,
    selectable: [relay],
    archives: { status: "loading", archived: [] },
  };
  const listeners = new Set<() => void>();
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="choice">
        {useDefaultAgent(session, "loading")?.name}
      </output>
    );
  }
  render(<Selection />);
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    setDefaultAgent("loading", relay.pubkey);
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Relay");
  act(() => {
    setDefaultAgent("loading", "d".repeat(64));
    choices = {
      ...choices,
      complete: true,
      pending: false,
      selectable: [relay, local],
    };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    choices = { ...choices, archives: { status: "ready", archived: [] } };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Local");
});

it("a requested agent replaces the default, and nothing stands in for it", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ requested }: { requested: string }) {
    return (
      <output aria-label={requested.slice(0, 1)}>
        {useDefaultAgent(session, "requested", requested)?.name ?? "none"}
      </output>
    );
  }
  render(
    <>
      <Selection requested={"b".repeat(64)} />
      <Selection requested={"d".repeat(64)} />
    </>,
  );
  expect(screen.getByLabelText("b").textContent).toBe("Second");
  expect(screen.getByLabelText("d").textContent).toBe("none");
});

it("keeps the main agent stable: saves the first pick and replaces only a deleted choice", () => {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: true };
  let choices = {
    status: "ready",
    complete: true,
    selectable: [first, second],
    archives: { status: "ready", archived: [] as string[] },
  };
  const listeners = new Set<() => void>();
  const update = (next: Partial<typeof choices>) => {
    choices = { ...choices, ...next };
    for (const notify of listeners) notify();
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "stable")?.name}
      </output>
    );
  }
  render(<Selection />);
  // The automatic pick is saved, so a different load order doesn't move it.
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [second, first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  // A chosen agent missing for a while is stood in for, then comes back.
  act(() => {
    setDefaultAgent("stable", second.pubkey);
  });
  act(() => update({ selectable: [first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [first, second] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("Second");
  // Deleting it hands the role on for good.
  act(() =>
    update({
      selectable: [first],
      archives: { status: "ready", archived: [second.pubkey] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() =>
    update({
      selectable: [second, first],
      archives: { status: "ready", archived: [] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
});
