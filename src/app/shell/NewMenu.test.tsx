// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { NewMenu } from "./NewMenu";
import { useRailLayout } from "./rail-layout";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

test("New section adds a section to the rail's own layout", async () => {
  const scope = `https://relay.example:${"c".repeat(64)}`;
  const owner = createRelaySession(null);
  owners.push(owner);
  const snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope,
    session: { ...owner.session, scope },
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  const rail = renderHook(() => useRailLayout(scope));
  render(<NewMenu relay={relay} navigator={{} as unknown as Navigation} />);
  const user = userEvent.setup();
  await user.pointer({
    keys: "[MouseRight]",
    target: screen.getByRole("button", { name: "New" }),
  });
  await user.click(
    await screen.findByRole("menuitem", { name: /New section/ }),
  );
  await user.type(
    await screen.findByRole("textbox", { name: "Section name" }),
    "Projects",
  );
  await act(() => user.click(screen.getByRole("button", { name: "Create" })));
  expect(rail.result.current.layout.sections).toEqual([
    { id: expect.stringMatching(/^custom:/), title: "Projects" },
  ]);
  expect(
    screen.queryByRole("dialog", { name: "Create new section" }),
  ).toBeNull();
});
