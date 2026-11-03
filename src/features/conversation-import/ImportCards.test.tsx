// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getEventHash } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import { foldMessages } from "../relay/fold";
import type { RelayData } from "../relay/service";
import { ImportedMarker, markedEdited } from "../messages/ImportedMarker";
import { ImportConsentCard, ImportProgressBanner } from "./ImportCards";
import { proposalTemplate } from "./protocol";
import type {
  ConversationImportService,
  ImportProposalInput,
  ImportSessionView,
} from "./types";

afterEach(cleanup);

const viewer = "a".repeat(64);
const partner = "b".repeat(64);
const relayKey = "c".repeat(64);
const channel = "f0".repeat(16);
const now = 1_740_000_000;
const input: ImportProposalInput = {
  channelId: channel,
  source: {
    type: "slack",
    conversation: "e".repeat(64),
    kind: "private_channel",
    label: "#project-room",
  },
  range: { from: 1_735_689_600, to: 1_735_776_000 },
  participants: [
    { pubkey: viewer, source_user: "2".repeat(64), messages: 12, reactions: 3 },
    { pubkey: partner, source_user: "3".repeat(64), messages: 8, reactions: 1 },
  ],
  excluded_authors: 2,
  manifest: "0123456789abcdef".repeat(4),
  expires_at: now + 86_400,
};

function event(
  pubkey: string,
  template: { kind: number; content: string; tags: string[][] },
  created_at = now - 60,
) {
  const unsigned = { ...template, pubkey, created_at };
  return { ...unsigned, id: getEventHash(unsigned), sig: "0".repeat(128) };
}

function harness(
  view?: Partial<ImportSessionView>,
  options: {
    input?: ImportProposalInput;
    refreshed?: Partial<ImportSessionView>;
    role?: string;
  } = {},
) {
  const source = options.input ?? input;
  const proposal = event(partner, proposalTemplate(source));
  const [row] = foldMessages(channel, relayKey, [proposal]);
  assert.exists(row?.importRecord);
  const verified = (displayName: string, username: string) => ({
    name: displayName,
    verified: {
      displayName,
      username,
      issuerLabel: "Example Directory",
      verifiedAt: 1_700_000_000,
      status: "checked" as const,
      multipleIssuers: false,
    },
  });
  const profiles = new Map([
    [viewer, verified("Viewer Person", "viewer")],
    [partner, verified("Partner Person", "partner")],
  ]);
  const session = {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    channels: {
      list: () => ({
        channels: [{ id: channel, viewerRole: options.role ?? "member" }],
      }),
    },
  };
  const connection = { session, viewer, status: "ready" };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const base: ImportSessionView = {
    proposalId: proposal.id,
    channelId: channel,
    proposer: partner,
    proposedAt: proposal.created_at,
    proposal: (({ channelId: _, ...rest }) => rest)(source),
    status: "proposed",
    required: source.participants.map((item) => item.pubkey),
    consents: { [partner]: "accept" },
    published: {},
    completed: [],
    expires_at: source.expires_at,
    confirmed: true,
  };
  const sessionView: ImportSessionView | undefined = view && {
    ...base,
    ...view,
  };
  const refreshedView = options.refreshed && { ...base, ...options.refreshed };
  const service = {
    session: () => sessionView,
    subscribe: (cb: (sessions: readonly ImportSessionView[]) => void) => {
      cb(sessionView ? [sessionView] : []);
      return () => {};
    },
    refresh: vi.fn(async () => refreshedView ?? sessionView),
    consent: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
  } as unknown as ConversationImportService & {
    consent: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
  return { row, relay, service, proposal };
}

it("renders the consent card with verified identities, counts and the manifest fingerprint", () => {
  const { row, relay, service, proposal } = harness({});
  render(<ImportConsentCard message={row} relay={relay} service={service} />);
  expect(screen.getByText("Import #project-room from Slack")).toBeTruthy();
  expect(screen.getByText(/1 of 2 accepted/)).toBeTruthy();
  expect(screen.getByText("Private channel")).toBeTruthy();
  expect(screen.getByText("20 messages, 4 reactions")).toBeTruthy();
  expect(
    screen.getByText(/Messages from 2 people without a verified/),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "01234567 89abcdef 01234567 89abcdef 01234567 89abcdef 01234567 89abcdef",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Viewer Person")).toBeTruthy();
  expect(
    screen.getByText(/@partner · 8 messages, 1 reactions · accepted/),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "bbbbbbbb bbbbbbbb bbbbbbbb bbbbbbbb bbbbbbbb bbbbbbbb bbbbbbbb bbbbbbbb",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  expect(service.consent).toHaveBeenCalledWith(
    proposal.id,
    "accept",
    "2".repeat(64),
  );
});

it("offers no decision once the import has ended", () => {
  const { row, relay, service } = harness({ status: "declined" });
  render(<ImportConsentCard message={row} relay={relay} service={service} />);
  expect(screen.getByText("Declined")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});

const outsiderInput: ImportProposalInput = {
  ...input,
  source: { ...input.source, kind: "public_channel" },
  participants: [
    input.participants[1] as ImportProposalInput["participants"][number],
  ],
};

it("reads its own snapshot so a member outside the import sees how it ended", async () => {
  const { row, relay, service, proposal } = harness(undefined, {
    input: outsiderInput,
    refreshed: { status: "completed" },
    role: "admin",
  });
  render(<ImportConsentCard message={row} relay={relay} service={service} />);
  await waitFor(() => expect(screen.getByText("Imported")).toBeTruthy());
  expect(service.refresh).toHaveBeenCalledWith(proposal.id, expect.anything());
  expect(screen.queryByRole("button", { name: "Approve as admin" })).toBeNull();
});

it("offers admin approval only on a live proposal", async () => {
  const live = harness(undefined, {
    input: outsiderInput,
    refreshed: { status: "proposed", consents: {} },
    role: "admin",
  });
  render(
    <ImportConsentCard
      message={live.row}
      relay={live.relay}
      service={live.service}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Approve as admin" }),
    ).toBeTruthy(),
  );
  cleanup();
  const expired = harness(undefined, {
    input: { ...outsiderInput, expires_at: Math.floor(Date.now() / 1000) - 1 },
    role: "admin",
  });
  expired.service.refresh.mockRejectedValue(new Error("offline"));
  render(
    <ImportConsentCard
      message={expired.row}
      relay={expired.relay}
      service={expired.service}
    />,
  );
  expect(screen.getByText("Expired before everyone accepted")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve as admin" })).toBeNull();
});

it("counts people done against every participant", () => {
  const active = harness({
    status: "active",
    required: [partner],
    completed: [partner],
  });
  render(<ImportProgressBanner channelId={channel} service={active.service} />);
  expect(screen.getByText(/1 of 2 people done/)).toBeTruthy();
});

it("shows a compact imported marker on continuation rows", () => {
  render(
    <ImportedMarker
      imported={{ proposalId: "1".repeat(64), source: "slack", ref: "1" }}
      compact
    />,
  );
  expect(screen.getByText("Imported")).toBeTruthy();
});

it("shows a progress banner only while the import is active", () => {
  const active = harness({
    status: "active",
    published: { [partner]: { messages: 8, reactions: 1 } },
    completed: [partner],
  });
  render(<ImportProgressBanner channelId={channel} service={active.service} />);
  expect(
    screen.getByText(
      "Importing #project-room from Slack: 9 of 24 items, 1 of 2 people done",
    ),
  ).toBeTruthy();
  cleanup();
  const done = harness({ status: "completed" });
  const { container } = render(
    <ImportProgressBanner channelId={channel} service={done.service} />,
  );
  expect(container.textContent).toBe("");
});

it("marks imported messages and their source edits", () => {
  const imported = event(
    viewer,
    {
      kind: 9,
      content: "From the archive",
      tags: [
        ["h", channel],
        ["import", "1".repeat(64)],
        ["source", "slack", "1735732800.000100"],
        ["source-edited", "1"],
      ],
    },
    1_735_732_800,
  );
  const plain = event(viewer, {
    kind: 9,
    content: "Live",
    tags: [["h", channel]],
  });
  const [first, second] = foldMessages(channel, relayKey, [imported, plain]);
  assert.exists(first?.imported);
  expect(second?.imported).toBeUndefined();
  expect(markedEdited(first)).toBe(true);
  render(<ImportedMarker imported={first.imported} />);
  expect(screen.getByText(/Imported from Slack · original time/)).toBeTruthy();
});
