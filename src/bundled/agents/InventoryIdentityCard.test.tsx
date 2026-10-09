// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { npubEncode } from "nostr-tools/nip19";
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
import { InventoryIdentityCard } from "./InventoryIdentityCard";
import { inventoryDecision } from "./inventory-decisions";
import { useState } from "react";
import type { ImportSource } from "../../features/agents/control";
function detailSurface(card: HTMLElement) {
  const name = card.getAttribute("aria-label")?.replace(/^Agent /, "");
  return screen.queryByRole("dialog", { name: `Manage ${name}` }) ?? card;
}
async function manage(card: HTMLElement) {
  const current = detailSurface(card);
  if (current !== card) return current;
  const menu = within(card).queryByRole("button", { name: /^Actions for / });
  if (!menu) {
    const details = card.querySelector("details");
    if (details && !details.open)
      fireEvent.click(within(card).getByLabelText(/^Details for /));
    return card;
  }
  fireEvent.click(menu);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Manage agent" }),
  );
  const dialog = await screen.findByRole("dialog", { name: /^Manage / });
  const details = dialog.querySelector("details");
  if (details && !details.open)
    fireEvent.click(within(dialog).getByText("Identity & sources"));
  return dialog;
}
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
  function Cards() {
    const [sources, setSources] = useState<Record<string, ImportSource>>({});
    const destination =
      mode === "disconnected" ? "" : "https://relay.example.test";
    return (
      <>
        {[...rows.values()].map((row) => (
          <InventoryIdentityCard
            key={row.pubkey}
            row={row}
            decision={inventoryDecision(row, destination)}
            community=""
            state={{ ...control.snapshot(), status: "ready", data: f.data }}
            control={control}
            session={owned.session}
            destination={destination}
            publicProfiles={new Map()}
            sourceProfiles={new Map()}
            edit={() => {}}
            importedId={null}
            onUseHere={onUseHere}
            onImport={onImport}
            selectedSource={sources[row.pubkey]}
            onSourceChange={(source) =>
              setSources((saved) => ({ ...saved, [row.pubkey]: source }))
            }
          />
        ))}
      </>
    );
  }
  render(<Cards />);
  return { f, onImport, onUseHere };
}
it("browses durable parked identities while disconnected without reading old files or keys", async () => {
  const { f } = setup("disconnected", (fixture) => {
    fixture.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Saved offline",
        sources: ["development"],
      },
    ];
  });
  const card = await screen.findByRole("article", {
    hidden: true,
    name: "Agent Saved offline",
  });
  expect(
    within(detailSurface(card)).queryByText(
      /^(Not imported|Imported locally)$/,
    ),
  ).toBeNull();
  expect(
    within(detailSurface(card)).queryByText(npubEncode("cd".repeat(32))),
  ).toBeNull();
  await manage(card);
  expect(
    within(detailSurface(card)).getByText(npubEncode("cd".repeat(32))),
  ).toBeVisible();
  expect(
    within(detailSurface(card)).getByText("Development Buzz"),
  ).toBeVisible();
  expect(
    f.calls.some(
      (call) => call.action === "preview" || call.action === "import",
    ),
  ).toBe(false);
  expect(
    within(detailSurface(card)).getByRole("button", { name: "Import" }),
  ).toBeEnabled();
  expect(
    within(detailSurface(card)).queryByRole("button", { name: "Use here" }),
  ).toBeNull();
  expect(f.calls.some((call) => call.action === "preview")).toBe(false);
});

it("offers Clone for a configured other-community setup and keeps its exact controls", async () => {
  setup("connected", (f) => {
    f.agent.relayUrl = "wss://elsewhere.example";
    f.agent.status = "stopped";
    f.agent.enabled = true;
  });
  const card = await screen.findByRole("article", {
    hidden: true,
    name: "Agent Fixture agent",
  });
  expect(card).toHaveClass("agent-inventory-row");
  expect(
    within(detailSurface(card)).getByLabelText("Details for Fixture agent"),
  ).toBeVisible();
  // The app runs this setup, so its lifecycle and settings stay reachable here.
  expect(
    within(detailSurface(card)).getByRole("button", { name: "Start" }),
  ).toBeVisible();
  expect(
    within(detailSurface(card)).getByRole("button", {
      name: "Actions for Fixture agent",
    }),
  ).toBeVisible();
  expect(
    within(detailSurface(card)).getByRole("button", { name: "Clone" }),
  ).toBeEnabled();
  expect(
    within(detailSurface(card)).queryByRole("button", {
      name: /^(Import|Use here)$/,
    }),
  ).toBeNull();
  expect(
    within(detailSurface(card)).queryByText(
      "Configured locally · community shown below",
    ),
  ).toBeNull();
  expect(
    within(detailSurface(card)).queryByText(
      /Connect to a destination|Imported locally/,
    ),
  ).toBeNull();
});

it("offers model setup on the card and Clone in management", async () => {
  setup("connected", (fixture) => {
    fixture.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Not imported",
        sources: ["development"],
      },
    ];
    fixture.host.cloneSettings = async () => ({
      name: "Reviewed agent",
      systemPrompt: "Instructions",
    });
  });
  const card = screen.getByRole("article", {
    hidden: true,
    name: "Agent Not imported",
  });
  const importButton = within(detailSurface(card)).getByRole("button", {
    name: "Set up model",
  });
  expect(
    within(detailSurface(card)).queryByRole("button", { name: "Clone" }),
  ).toBeNull();
  await manage(card);
  const cloneButton = within(detailSurface(card)).getByRole("button", {
    name: "Clone",
  });
  expect(importButton).toBeEnabled();
  expect(cloneButton).toBeEnabled();
  expect(importButton).toHaveAttribute("data-variant", "ghost");
  expect(cloneButton).toHaveAttribute("data-variant", "subtle");
});

it.each([
  [false, false, false, false, false],
  [false, false, true, true, true],
  [false, true, false, false, true],
  [false, true, true, false, true],
])(
  "card actions: community=%s local=%s oldBuzz=%s => Import=%s Clone=%s",
  async (community, local, oldBuzz, showImport, showClone) => {
    const pubkey = "cd".repeat(32);
    setup(
      "connected",
      (f) => {
        f.data.agents = local
          ? [
              {
                ...f.agent,
                pubkey,
                configured: false,
                relayUrl: "wss://elsewhere.example",
              },
            ]
          : [];
        f.data.parked = oldBuzz
          ? [{ pubkey, name: "Not imported", sources: ["installed"] }]
          : [];
      },
      community ? [pubkey] : [],
    );
    const card = screen.getByRole("article", {
      hidden: true,
      name: "Agent Not imported",
    });
    expect(
      !!within(detailSurface(card)).queryByRole("button", {
        name: "Set up model",
      }),
    ).toBe(showImport || local);
    await manage(card);
    expect(
      !!within(detailSurface(card)).queryByRole("button", { name: "Clone" }),
    ).toBe(showClone);
    expect(screen.queryByText(/No import source confirmed/)).toBeNull();
  },
);

it("dispatches the chosen source and exact key without importing credentials", async () => {
  const { f, onImport, onUseHere } = setup("connected", (f) => {
    f.host.cloneSettings = vi.fn(async () => ({
      name: "Reviewed agent",
      systemPrompt: "Instructions",
    }));
    f.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Shared source",
        sources: ["installed", "development"],
      },
    ];
  });
  const card = screen.getByRole("article", {
    hidden: true,
    name: "Agent Shared source",
  });
  expect(
    within(detailSurface(card)).getByRole("button", { name: "Set up model" }),
  ).toBeDisabled();
  await manage(card);
  fireEvent.change(
    within(detailSurface(card)).getByLabelText("Old Buzz installation"),
    {
      target: { value: "development" },
    },
  );
  fireEvent.click(
    within(detailSurface(card)).getByRole("button", { name: "Import" }),
  );
  expect(onImport).toHaveBeenCalledWith("cd".repeat(32), "development");
  await manage(card);
  fireEvent.click(
    within(detailSurface(card)).getByRole("button", { name: "Clone" }),
  );
  expect(onUseHere).toHaveBeenCalledWith(
    "cd".repeat(32),
    "clone",
    "development",
  );
  expect(f.host.cloneSettings).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});
