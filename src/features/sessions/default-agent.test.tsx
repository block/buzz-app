// @vitest-environment jsdom
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
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable" },
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
