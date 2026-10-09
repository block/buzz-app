// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import { inventoryIdentities } from "./inventory-model";
import { InventoryView } from "./InventoryView";
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(
  mode: string,
  configure: (f: ReturnType<typeof controlFixture>) => void,
  identities = ["cd".repeat(32)],
  definitions: { id: string; name: string }[] = [],
) {
  const f = controlFixture();
  configure(f);
  const owned = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    query: async () => [],
    media: () => undefined,
  });
  const control = createAgentControl(f.host);
  disposals.push(() => {
    owned.dispose();
    control.dispose();
  });
  const rows = inventoryIdentities(
    mode === "disconnected"
      ? []
      : [
          {
            pubkey: "cd".repeat(32),
            name: "Not imported",
            definitionId: "linked",
          },
        ],
    mode === "disconnected"
      ? new Map()
      : new Map([["https://relay.example.test", identities]]),
    f.data,
    (_key, fallback) => fallback,
  );
  const onImport = vi.fn();
  const onUseHere = vi.fn();
  let importTab = false;
  const view = () => (
    <InventoryView
      importTab={importTab}
      state={{ ...control.snapshot(), status: "ready", data: f.data }}
      control={control}
      session={owned.session}
      destination={mode === "disconnected" ? "" : "https://relay.example.test"}
      rows={rows}
      profiles={definitions}
      publicProfiles={new Map()}
      sourceProfiles={new Map()}
      edit={() => {}}
      importedId={null}
      onUseHere={onUseHere}
      onImport={onImport}
    />
  );
  const mounted = render(view());
  return {
    f,
    onImport,
    onUseHere,
    rows,
    redraw: () => mounted.rerender(view()),
    showImport: () => {
      importTab = true;
      mounted.rerender(view());
    },
  };
}
it("shows only locally configured agents in Your agents", async () => {
  setup(
    "connected",
    (f) => {
      f.data.parked = [
        { pubkey: "ee".repeat(32), name: "Importable", sources: ["installed"] },
      ];
    },
    ["cd".repeat(32)],
    [{ id: "empty", name: "Profile only" }],
  );
  await screen.findByRole("article", { name: "Agent Fixture agent" });
  for (const name of [
    "Available to import",
    "Relay-only agents",
    "Profiles without identities",
  ]) {
    expect(screen.queryByRole("region", { name })).toBeNull();
  }
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
  expect(screen.queryByText("Importable")).toBeNull();
  expect(screen.queryByText("Profile only")).toBeNull();
});

it("sorts local agents without merging equal names", async () => {
  setup("connected", (f) => {
    f.data.agents = ["Zebra", "beta", "Alpha", "Alpha"].map((name, i) => ({
      ...f.agent,
      id: String(i),
      pubkey: String(i + 1).repeat(64),
      name,
    }));
  });
  const group = await screen.findByRole("region", {
    name: "Local agents in this community",
  });
  expect(
    within(group)
      .getAllByRole("article")
      .map((card) => card.getAttribute("aria-label")),
  ).toEqual(["Agent Alpha", "Agent Alpha", "Agent beta", "Agent Zebra"]);
});

it("renders local sections with all setups on one exact-key card", async () => {
  setup("connected", (f) => {
    const here = { ...f.agent };
    f.data.agents.push({
      ...here,
      id: "same-key-other",
      relayUrl: "wss://second.example",
    });
    f.data.agents.push({
      ...here,
      id: "other-key",
      pubkey: "ee".repeat(32),
      relayUrl: "wss://third.example",
    });
    f.data.parked = [
      {
        pubkey: here.pubkey.toUpperCase(),
        name: "Shared",
        sources: ["installed", "development"],
      },
      {
        pubkey: "ff".repeat(32),
        name: "Importable",
        sources: ["installed", "development"],
      },
    ];
  });
  const local = await screen.findByRole("region", {
    name: "Local agents in this community",
  });
  const card = within(local).getByRole("article", { name: "Agent Shared" });
  expect(screen.getAllByRole("article", { name: "Agent Shared" })).toHaveLength(
    1,
  );
  fireEvent.click(within(card).getByLabelText("Actions for Shared"));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Manage agent" }),
  );
  const management = await screen.findByRole("dialog", {
    name: "Manage Shared",
  });
  // Each saved setup keeps its own controls, including the one in another community.
  expect(
    within(management).getAllByRole("button", { name: "Stop" }),
  ).toHaveLength(2);
  expect(
    within(management).getByText("Installed Buzz · Development Buzz"),
  ).not.toBeVisible();
  fireEvent.click(
    within(management).queryByText("Identity & sources") ??
      within(management).getByLabelText(/^Details for /),
  );
  expect(
    within(management).getByText("Installed Buzz · Development Buzz"),
  ).toBeVisible();
  fireEvent.click(within(management).getByRole("button", { name: "Close" }));
  expect(
    within(
      screen.getByRole("region", { name: "Local agents in other communities" }),
    ).getAllByRole("article"),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("region", { name: "Available to import" }),
  ).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Relay-only agents" }),
  ).toBeNull();
});

it("nests local rows by saved community once, with unknown last", async () => {
  setup("connected", (f) => {
    const agent = { ...f.agent };
    f.data.agents = [
      {
        ...agent,
        id: "z",
        name: "Several setups",
        relayUrl: "wss://z.example",
      },
      {
        ...agent,
        id: "a",
        name: "Several setups",
        relayUrl: "wss://a.example",
      },
      {
        ...agent,
        id: "b",
        pubkey: "bb".repeat(32),
        name: "Second",
        relayUrl: "wss://b.example",
      },
      {
        ...agent,
        id: "unknown",
        pubkey: "aa".repeat(32),
        name: "Legacy",
        relayUrl: "",
        configured: false,
      },
    ];
  });
  const group = await screen.findByRole("region", {
    name: "Local agents in other communities",
  });
  expect(
    within(group)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent),
  ).toEqual(["https://a.example", "https://b.example", "Community unknown"]);
  const first = within(group).getByRole("region", {
    name: "https://a.example",
  });
  const row = within(first).getByRole("article", {
    name: "Agent Several setups",
  });
  expect(
    screen.getAllByRole("article", { name: "Agent Several setups" }),
  ).toHaveLength(1);
  expect(within(row).getByRole("heading", { level: 4 })).toHaveTextContent(
    "Several setups",
  );
  // Every saved setup of the key keeps its exact controls on the one row.
  expect(within(row).getAllByRole("button", { name: "Stop" })).toHaveLength(2);
  fireEvent.click(within(row).getByLabelText(/^Details for /));
  // The z setup keeps its own controls, so it names its community there.
  expect(within(row).getByText("wss://z.example")).toBeVisible();
  expect(within(row).queryByText("wss://a.example")).toBeNull();
  expect(within(row).queryByRole("button", { name: "Use here" })).toBeNull();
  fireEvent.click(within(row).getByLabelText("Details for Several setups"));
  expect(within(row).getByRole("button", { name: "Clone" })).toBeVisible();
  expect(
    within(group).getByRole("region", { name: "Community unknown" }),
  ).toHaveTextContent("Legacy");
});

it("moves relay identities to Import while retaining the same cards", () => {
  const { rows, redraw, showImport } = setup("connected", (f) => {
    f.data.agents = [];
  });
  redraw();
  expect(rows.size).toBeGreaterThan(0);
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
  showImport();
  expect(
    screen.getByRole("article", { name: "Agent Not imported" }),
  ).toBeVisible();
  expect(
    screen.queryByText("No agents yet. Add an agent to get started."),
  ).toBeNull();
});
