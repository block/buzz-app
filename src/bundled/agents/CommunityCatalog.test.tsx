// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunityCatalog } from "../../features/agents/catalog";
import {
  catalogRelay,
  memoryStorage,
} from "../../features/agents/catalog-testing";
import { createOutbox } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { keypair, signed, type Key } from "../../features/relay/testing";
import { CatalogShareSwitch, CommunityCatalogDialog } from "./CommunityCatalog";

const alice = keypair(),
  bob = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});

function client(server: ReturnType<typeof catalogRelay>, as: Key) {
  const writes = createOutbox(as.pubkey, server.writer(as), memoryStorage(), {
    timeoutMs: 1_000,
  });
  const catalog = createCommunityCatalog({
    reader: server.reader(as),
    viewer: as.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  const session = {
    communityCatalog: catalog.queries,
    scope: "wss://catalog.test",
    viewer: as.pubkey,
    names: undefined,
    media: undefined,
  } as unknown as RelaySession;
  return { catalog: catalog.queries, session };
}

const agentBody = JSON.stringify({
  display_name: "Helper",
  system_prompt:
    "Read [this](javascript:alert(1)) <img src=x onerror=alert(1)>",
});
const teamBody = JSON.stringify({
  v: 1,
  name: "Crew",
  members: [{ member_key: "k1", display_name: "Mate", system_prompt: "Help." }],
});
const shareSwitch = () =>
  screen.getByRole("switch", { name: /Share to catalog/ });
const checked = () => shareSwitch().getAttribute("aria-checked") === "true";
const enabled = () =>
  shareSwitch().getAttribute("aria-disabled") !== "true" &&
  !shareSwitch().hasAttribute("data-disabled");

function renderSwitch(catalog: RelaySession["communityCatalog"]) {
  return render(
    <CatalogShareSwitch
      catalog={catalog}
      kind={30175}
      d="helper"
      name="Helper"
      description="Shared."
      content={() => agentBody}
    />,
  );
}

it("shows queued then accepted sharing, and unsharing hides it from another user", async () => {
  const server = catalogRelay();
  const owner = client(server, alice);
  renderSwitch(owner.catalog);
  await waitFor(() => expect(enabled()).toBe(true));
  const release = server.hold();
  fireEvent.click(shareSwitch());
  await screen.findByText(
    "Sharing Helper is queued. It will appear after the relay accepts the update.",
  );
  expect(checked()).toBe(true);
  release();
  await screen.findByText("Published Helper to the community catalog.");

  const viewer = client(server, bob);
  await viewer.catalog.refresh();
  expect(viewer.catalog.snapshot().agents.map((a) => a.d)).toEqual(["helper"]);

  await waitFor(() => expect(enabled()).toBe(true));
  fireEvent.click(shareSwitch());
  await screen.findByText(
    "Helper is no longer discoverable in the community catalog.",
  );
  expect(checked()).toBe(false);
  await viewer.catalog.refresh();
  expect(viewer.catalog.snapshot().agents).toEqual([]);
});

it("shows a relay rejection with a retry that succeeds", async () => {
  const server = catalogRelay();
  const owner = client(server, alice);
  renderSwitch(owner.catalog);
  await waitFor(() => expect(enabled()).toBe(true));
  server.refuse(true);
  fireEvent.click(shareSwitch());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("blocked: not today");
  expect(checked()).toBe(false);
  server.refuse(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Published Helper to the community catalog.");
  expect(checked()).toBe(true);
});

it("previews shared entries as plain text and adds an explicit copy", async () => {
  const server = catalogRelay();
  server.put(
    signed(alice, {
      kind: 30175,
      tags: [
        ["d", "helper"],
        ["shared", "true"],
      ],
      content: agentBody,
      created_at: 1,
    }),
  );
  server.put(
    signed(alice, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content: teamBody,
      created_at: 1,
    }),
  );
  const viewer = client(server, bob);
  const onAddAgent = vi.fn();
  const onAddTeam = vi.fn(async () => {});
  const { container } = render(
    <CommunityCatalogDialog
      session={viewer.session}
      onClose={() => {}}
      onAddAgent={onAddAgent}
      onAddTeam={onAddTeam}
    />,
  );
  await screen.findByText("Agent instructions");
  expect(screen.getByText("Community member")).toBeTruthy();
  expect(container.ownerDocument.querySelector("img[src=x]")).toBeNull();
  expect(
    container.ownerDocument.querySelector('a[href^="javascript"]'),
  ).toBeNull();
  expect(
    screen.getByText(/Read \[this\]\(javascript:alert\(1\)\)/).tagName,
  ).toBe("PRE");
  fireEvent.click(
    screen.getByRole("button", { name: "Add Helper from Community Catalog" }),
  );
  expect(onAddAgent).toHaveBeenCalledWith(
    expect.objectContaining({ d: "helper", owner: alice.pubkey }),
  );

  fireEvent.click(screen.getByRole("button", { name: /Crew/ }));
  await screen.findByText("1 member");
  fireEvent.click(
    screen.getByRole("button", { name: "Add Crew from Community Catalog" }),
  );
  await screen.findByRole("button", { name: "Crew is already in your teams" });
  expect(onAddTeam).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Crew is already in your teams" })
      .textContent,
  ).toContain("Added to my teams");
});

it("shows the empty catalog copy", async () => {
  const viewer = client(catalogRelay(), bob);
  render(
    <CommunityCatalogDialog session={viewer.session} onClose={() => {}} />,
  );
  await screen.findByText("Nothing shared yet");
  expect(
    screen.getByText("Shared agents and teams will appear here."),
  ).toBeTruthy();
});
