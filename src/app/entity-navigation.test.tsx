// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { bindDeepLinks } from "../features/navigation/deep-links";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter } from "../features/relay/events";

vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.projects", name: "Projects", apiVersion: 1 },
      module: await import("../bundled/projects"),
    },
  ],
}));
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example";
const project = finalizeEvent(
  {
    kind: 30621,
    created_at: 1,
    content: "",
    tags: [
      ["d", "project"],
      ["name", "Recovered project"],
      ["description", "Actual recovered destination"],
    ],
  },
  key,
);
let services: AppServices | undefined;
let stop = () => {};
afterEach(async () => {
  cleanup();
  stop();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
it("keeps an OS entity intent through real community selection and Retry in App", async () => {
  // jsdom has no layout observer; App now keeps its real sidebar mounted here.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: null,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          [project].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  const queue = [`buzz://project?owner=${viewer}&d=project`];
  let ping = () => {};
  stop = bindDeepLinks(current.navigationHost, current.communities, {
    take: async () => queue.splice(0),
    watch(listener) {
      ping = listener;
      return () => {};
    },
  });
  render(<App services={current} />);
  await screen.findByRole("button", { name: "Retry navigation" });
  expect(current.navigation.snapshot()).toMatchObject({
    ingress: true,
    retryable: true,
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Switch to Fixture community" }),
  );
  expect(current.navigation.snapshot().ingress).toBe(true);
  await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
  await userEvent.click(
    screen.getByRole("button", { name: "Retry navigation" }),
  );
  await screen.findByText("Actual recovered destination");
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: {
      target: {
        kind: "page",
        pluginId: "buzz.projects",
        route: { params: { type: "project", dtag: "project" } },
      },
    },
  });
  await act(async () => {
    queue.push("buzz://unsupported");
    ping();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "invalid or unsupported",
  );
  expect(
    screen.queryByRole("button", { name: "Retry navigation" }),
  ).not.toBeInTheDocument();
});

it.each(["compute", "wallet"] as const)(
  "opens the built-in %s settings destination",
  async (section) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    services = createServices();
    const current = services;
    render(<App services={current} />);
    await waitFor(() =>
      expect(current.plugins.snapshot().configuration.status).toBe("ready"),
    );

    await act(async () => {
      await current.navigation.open({ version: 1, kind: "settings", section });
    });

    await waitFor(() =>
      expect(current.navigation.snapshot().status).toBe("opened"),
    );
    expect(
      screen.getByRole("button", { name: new RegExp(section, "i") }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("heading", { name: "This destination couldn’t open" }),
    ).not.toBeInTheDocument();
  },
);
