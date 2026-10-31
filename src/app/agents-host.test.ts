// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { lanes } from "../features/agents/lanes";
import { link } from "../features/agents/link";
import { type PageState, servePage } from "../features/agents/page-link";
import { createAgentsHost } from "./agents-host";

it("starts the Runner once the screens' page says where agent storage is, and serves the Manager its agent types", async () => {
  const channel = new MessageChannel();
  const host = createAgentsHost(channel.port1);
  const screens = lanes(channel.port2, ["agents", "page"]);
  let state: PageState | undefined;
  const listeners = new Set<() => void>();
  const page = link(
    screens.page,
    servePage({
      snapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  );
  const manager = link(screens.agents);
  manager.watch("runner.types", null, () => {});
  page.watch("activity.work", null, () => {});
  // The agents page shows its local work at once.
  await vi.waitFor(() => expect(page.read("activity.work")).toEqual([]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(manager.read("runner.types")).toBeUndefined();
  state = Object.freeze({
    storage: "local",
    communities: { memberships: [], selected: null },
  });
  for (const listener of [...listeners]) listener();
  await vi.waitFor(() =>
    expect(manager.read("runner.types")).toEqual(expect.any(Array)),
  );
  manager.close();
  page.close();
  await host.dispose();
});
