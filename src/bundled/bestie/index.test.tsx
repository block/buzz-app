// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BestiePage } from "./index";
import type { Navigation } from "../../features/navigation/controller";
import { bestieFixture, cleanups, COMMUNITY } from "./testing";
import { deferred } from "../builderlab/test-helpers";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        options: { signal: AbortSignal },
        work: () => Promise<void>,
      ) => {
        options.signal.throwIfAborted();
        return work();
      },
    },
  });
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
});
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "locks");
});
function navigationFixture() {
  const open = vi.fn(async () => ({ status: "opened" }));
  return { open, navigation: { open } as unknown as Navigation };
}

it("keeps the completed private chat reachable when workflow setup fails and resumes rhythms separately", async () => {
  const h = await bestieFixture();
  const query = h.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  h.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30620)))
      throw new Error("unavailable");
    return query(filters);
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot().record?.complete).toBe(true);
  expect(h.bestie.snapshot().status).toBe("error");
  const nav = navigationFixture();
  render(<BestiePage bestie={h.bestie} navigation={nav.navigation} />);
  expect(nav.open).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Bestie conversation" }),
  );
  await waitFor(() => expect(nav.open).toHaveBeenCalledOnce());
  h.query.mockImplementation(query);
  fireEvent.click(
    screen.getByRole("button", { name: "Set up Bestie workflows" }),
  );
  await waitFor(() => expect(nav.open).toHaveBeenCalledTimes(2));
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9)).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 30620)).toHaveLength(3);
});

it("keeps Bestie available with a route to enable Builderlab", () => {
  const h = navigationFixture();
  render(<BestiePage navigation={h.navigation} />);
  expect(screen.getByRole("status")).toHaveTextContent("Enable Builderlab");
  fireEvent.click(screen.getByRole("button", { name: "Plugin settings" }));
  expect(h.open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "plugins",
  });
});

it("signs in on Bestie and explains community selection separately without creating an agent", async () => {
  const h = await bestieFixture();
  h.builderlab.login.signOut();
  h.setCommunity(null);
  const nav = navigationFixture();
  render(<BestiePage bestie={h.bestie} navigation={nav.navigation} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(
    await screen.findByText(/Choose a community from the left sidebar/),
  ).toBeVisible();
  expect(h.builderlab.login.snapshot().status).toBe("signed-in");
  expect(
    screen.queryByRole("button", { name: "Sign in with Builderlab" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Create agent" }),
  ).not.toBeInTheDocument();
  expect(h.request).not.toHaveBeenCalled();
  act(() => h.setCommunity(COMMUNITY));
  expect(
    await screen.findByRole("button", { name: "Set up Bestie" }),
  ).toBeEnabled();
});

it("offers saved communities directly on Bestie with an owner-bound navigation target", async () => {
  const h = await bestieFixture();
  h.setCommunity(null);
  h.addCommunity();
  const nav = navigationFixture();
  render(
    <BestiePage
      bestie={h.bestie}
      navigation={nav.navigation}
      communityReader={h.communityReader}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Use Test community" }));
  expect(nav.open).toHaveBeenCalledWith(
    {
      version: 1,
      kind: "page",
      pluginId: "buzz.bestie",
      pageId: "bestie",
      scope: { viewer: h.viewer, communityOrigin: COMMUNITY },
    },
    { replace: true },
  );
  expect(h.request).not.toHaveBeenCalled();
});

it("finishes setup through the real client and Outbox, opens chat automatically, and reopens the same channel", async () => {
  const h = await bestieFixture();
  const nav = navigationFixture();
  const mounted = render(
    <BestiePage bestie={h.bestie} navigation={nav.navigation} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set up Bestie" }));
  await waitFor(() => expect(nav.open).toHaveBeenCalledOnce());
  const record = h.bestie.snapshot().record;
  expect(record?.complete).toBe(true);
  expect(nav.open).toHaveBeenCalledWith(
    {
      version: 1,
      kind: "conversation",
      channelId: record?.channelId,
      scope: { viewer: h.viewer, communityOrigin: COMMUNITY },
    },
    { replace: true },
  );
  expect(h.channels.get(record?.channelId ?? "")?.members).toEqual([
    h.viewer,
    h.agent,
  ]);
  expect(h.events.map((event) => event.kind)).toEqual([
    30177, 9007, 9000, 9, 30620, 30620, 30620,
  ]);
  h.customize("Keep these personal instructions.");
  mounted.unmount();
  render(<BestiePage bestie={h.bestie} navigation={nav.navigation} />);
  await waitFor(() => expect(nav.open).toHaveBeenCalledTimes(2));
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
  expect(h.instructions()).toBe("Keep these personal instructions.");
  expect(h.channels.size).toBe(1);
  expect(screen.queryByText("New workflow")).not.toBeInTheDocument();
});

it("selects one of the existing Besties and opens its private channel without registering another", async () => {
  const h = await bestieFixture();
  const existing = h.existingBesties();
  const nav = navigationFixture();
  render(<BestiePage bestie={h.bestie} navigation={nav.navigation} />);
  fireEvent.click(screen.getByRole("button", { name: "Set up Bestie" }));
  const use = await screen.findByRole("button", {
    name: `Use Bestie · ${h.agent.slice(0, 12)}`,
  });
  expect(h.requests("register-agent")).toHaveLength(0);
  fireEvent.click(use);
  await waitFor(() => expect(nav.open).toHaveBeenCalledOnce());
  expect(h.bestie.snapshot().record?.agent?.id).toBe(existing[0]?.agent_id);
  expect(h.requests("register-agent")).toHaveLength(0);
  expect(h.channels.size).toBe(1);
});

it("does not navigate after setup fails and resumes the same setup on retry", async () => {
  const h = await bestieFixture();
  h.failPublication(9007);
  const nav = navigationFixture();
  render(<BestiePage bestie={h.bestie} navigation={nav.navigation} />);
  fireEvent.click(screen.getByRole("button", { name: "Set up Bestie" }));
  await screen.findByRole("button", { name: "Retry Bestie setup" });
  expect(nav.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry Bestie setup" }));
  await waitFor(() => expect(nav.open).toHaveBeenCalledOnce());
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.channels.size).toBe(1);
});

it("offers chat navigation retry when presentation fails without repeating setup", async () => {
  const h = await bestieFixture();
  await h.bestie.setup();
  const nav = navigationFixture();
  nav.open.mockResolvedValueOnce({ status: "failed" });
  render(<BestiePage bestie={h.bestie} navigation={nav.navigation} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not open Bestie's channel",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open Bestie conversation" }),
  );
  await waitFor(() => expect(nav.open).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(h.requests("register-agent")).toHaveLength(1);
});

it.each(["open", "member"] as const)(
  "checks the current private audience before reopening a changed %s home",
  async (change) => {
    const h = await bestieFixture();
    await h.bestie.setup();
    h.unsafeHome(change);
    const nav = navigationFixture();
    render(<BestiePage bestie={h.bestie} navigation={nav.navigation} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "private and contain only you and Bestie",
    );
    expect(nav.open).not.toHaveBeenCalled();
    expect(h.requests("register-agent")).toHaveLength(1);
  },
);

it("does not navigate back after leaving during a manual chat retry", async () => {
  const h = await bestieFixture();
  await h.bestie.setup();
  const nav = navigationFixture();
  nav.open.mockResolvedValueOnce({ status: "failed" });
  const mounted = render(
    <BestiePage bestie={h.bestie} navigation={nav.navigation} />,
  );
  await screen.findByRole("alert");
  const gate = deferred<void>();
  const started = deferred<void>();
  const finished = deferred<void>();
  const original = h.query.getMockImplementation();
  if (!original) throw new Error("Missing query implementation");
  h.query.mockImplementationOnce(async (filters) => {
    started.resolve();
    await gate.promise;
    const result = await original(filters);
    finished.resolve();
    return result;
  });
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open Bestie conversation" }),
    );
    await started.promise;
    mounted.unmount();
    await act(async () => {
      gate.resolve();
      await finished.promise;
    });
    expect(nav.open).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
  }
});
