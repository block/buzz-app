// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { bytesToHex } from "nostr-tools/utils";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { profileTarget } from "../../features/profiles/target";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { LiveCallbacks } from "../../features/relay/live";
import type { RelayData } from "../../features/relay/service";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import {
  keypair,
  type Key,
  profile,
  signed,
} from "../../features/relay/testing";
import { ProfilePanel } from "./ProfilePanel";

const relayKey = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

function auth(agent: Key, owner: Key, sign = owner) {
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${agent.pubkey}:`).digest(),
  );
  return [
    "auth",
    owner.pubkey,
    "",
    bytesToHex(schnorr.sign(digest, sign.secret)),
  ];
}
function agentProfile(agent: Key, tags: string[][]) {
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name: "Helper" }),
    tags,
  });
}
function mount(
  target: Key,
  respond: (filter: ReadFilter) => RelayEvent[],
  {
    archiveAuthority,
    wrap,
  }: {
    archiveAuthority?: string;
    wrap?: (session: RelaySession) => RelaySession;
  } = {},
) {
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    filters.flatMap((filter) => respond(filter)),
  );
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query,
    media: () => undefined,
    ...(archiveAuthority ? { archiveAuthority } : {}),
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  owners.push(owner);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: wrap ? wrap(owner.session) : owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const open = vi.fn(() => true);
  render(
    <ProfilePanel
      relay={relay}
      target={profileTarget(target.pubkey) ?? ""}
      close={() => {}}
      context={{ channelId: "c", canOpen: () => true, open }}
    />,
  );
  return { query, open };
}
const kind0 = (filter: ReadFilter) => filter.kinds?.includes(0);

it("shows a verified owner with profile ingress and relay archive state", async () => {
  const agent = keypair();
  const owner = keypair();
  const archive = signed(relayKey, {
    kind: 13535,
    content: "",
    tags: [["-"], ["p", agent.pubkey]],
  });
  const { open } = mount(
    agent,
    (filter) =>
      filter.kinds?.includes(13535)
        ? [archive]
        : filter.authors?.includes(owner.pubkey)
          ? [profile(owner, { name: "Owner Olivia" })]
          : kind0(filter)
            ? [agentProfile(agent, [auth(agent, owner)])]
            : [],
    { archiveAuthority: relayKey.pubkey },
  );
  const identity = await screen.findByRole("region", {
    name: "Agent identity",
  });
  const ownerLink = await screen.findByRole("button", {
    name: "Open owner profile: Owner Olivia",
  });
  expect(identity).toHaveTextContent("Authorized by Owner Olivia");
  await waitFor(() =>
    expect(identity).toHaveTextContent("Archived on this relay"),
  );
  await userEvent.setup().click(ownerLink);
  expect(open).toHaveBeenCalledWith(profileTarget(owner.pubkey));
});

it("does not trust a well-formed attestation with an invalid signature", async () => {
  const agent = keypair();
  const owner = keypair();
  mount(agent, (filter) =>
    kind0(filter) ? [agentProfile(agent, [auth(agent, owner, keypair())])] : [],
  );
  const identity = await screen.findByRole("region", {
    name: "Agent identity",
  });
  await waitFor(() =>
    expect(identity).toHaveTextContent(
      "Not verified — no valid owner attestation.",
    ),
  );
  expect(identity).toHaveTextContent("ArchiveUnknown");
  expect(identity).not.toHaveTextContent("Authorized by");
  expect(screen.queryByRole("button", { name: /owner profile/ })).toBeNull();
});

it("reports an unknown owner when no relay view is available, then retries", async () => {
  const agent = keypair();
  const observe = vi.fn(() => {
    throw new Error("Relay view capacity unavailable");
  });
  mount(
    agent,
    (filter) =>
      kind0(filter) ? [profile(agent, { name: "Helper", is_agent: true })] : [],
    {
      wrap: (session) => {
        let calls = 0;
        return Object.create(session, {
          observe: {
            value: (filters: readonly ReadFilter[]) =>
              calls++ ? session.observe(filters) : observe(),
          },
        });
      },
    },
  );

  const identity = await screen.findByRole("region", {
    name: "Agent identity",
  });
  expect(identity).toHaveTextContent(
    "Unknown — could not read this profile's attestation.",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry agent details" }));
  await waitFor(() =>
    expect(identity).toHaveTextContent(
      "Not verified — no valid owner attestation.",
    ),
  );
  expect(observe).toHaveBeenCalledTimes(1);
});

it("adds no agent section or reads for a profile without an agent hint", async () => {
  const person = keypair();
  const { query } = mount(person, (filter) =>
    kind0(filter) ? [profile(person, { name: "Person" })] : [],
  );
  await screen.findByRole("heading", { name: "Person" });
  expect(screen.queryByRole("region", { name: "Agent identity" })).toBeNull();
  expect(query).toHaveBeenCalledTimes(1);
});

function timedProfile(
  agent: Key,
  tags: string[][],
  time: number,
  name = "Helper",
) {
  return signed(agent, {
    kind: 0,
    content: JSON.stringify({ name, is_agent: true }),
    tags,
    created_at: time,
  });
}
function live(agent: Key, first: RelayEvent, archives = false) {
  let latest = first;
  let callbacks!: LiveCallbacks;
  let archiveOffline = true;
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    filters.flatMap((filter) => {
      if (filter.kinds?.includes(13535)) {
        if (archiveOffline) throw new Error("offline");
        return [
          signed(relayKey, {
            kind: 13535,
            content: "",
            tags: [["-"], ["p", agent.pubkey]],
          }),
        ];
      }
      return kind0(filter) && filter.authors?.includes(agent.pubkey)
        ? [latest]
        : [];
    }),
  );
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: relayKey.pubkey,
    scope: "wss://relay.example.test",
    ...(archives ? { archiveAuthority: relayKey.pubkey } : {}),
    query,
    media: () => undefined,
    subscribe: (next) => {
      callbacks = next;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const props = {
    relay,
    target: profileTarget(agent.pubkey) ?? "",
    close() {},
    context: { channelId: "c", canOpen: () => true, open: () => true },
  };
  const mounted = render(<ProfilePanel {...props} />);
  return {
    session: owner.session,
    query,
    receive: (event: RelayEvent) =>
      act(async () => {
        callbacks.receive([event]);
      }),
    setLatest(event: RelayEvent) {
      latest = event;
    },
    recoverArchives() {
      archiveOffline = false;
    },
    reopen() {
      mounted.unmount();
      render(<ProfilePanel {...props} />);
    },
    rerender() {
      mounted.rerender(<ProfilePanel {...props} />);
    },
  };
}
const ownerButton = (owner: Key) => ({
  name: `Open owner profile: ${owner.pubkey.slice(0, 10)}…`,
});
const archiveReads = (query: ReturnType<typeof live>["query"]) =>
  query.mock.calls.filter(([filters]) =>
    filters.some((filter) => filter.kinds?.includes(13535)),
  ).length;

it.each(["remove", "duplicate", "replace"])(
  "follows the current signed profile after an auth-only %s",
  async (mode) => {
    const agent = keypair();
    const a = keypair();
    const b = keypair();
    const h = live(agent, timedProfile(agent, [auth(agent, a)], 100));
    await screen.findByRole("button", ownerButton(a));
    const before = h.session.profiles.snapshot().get(agent.pubkey);
    const tags =
      mode === "remove"
        ? []
        : mode === "duplicate"
          ? [auth(agent, a), auth(agent, a)]
          : [auth(agent, b)];
    const next = timedProfile(agent, tags, 101);
    h.setLatest(next);
    await h.receive(next);
    // A duplicate keeps the projected owner, so only event provenance can drive it.
    if (mode === "duplicate")
      expect(h.session.profiles.snapshot().get(agent.pubkey)).toBe(before);
    h.rerender();
    const identity = screen.getByRole("region", { name: "Agent identity" });
    if (mode === "replace") await screen.findByRole("button", ownerButton(b));
    else
      await waitFor(() =>
        expect(identity).toHaveTextContent("Not verified — no valid owner"),
      );
    expect(screen.queryByRole("button", ownerButton(a))).toBeNull();
  },
);

it("does not resurrect older provenance from a lagging finite read", async () => {
  const agent = keypair();
  const a = keypair();
  const h = live(agent, timedProfile(agent, [auth(agent, a)], 100));
  await screen.findByRole("button", ownerButton(a));
  // Live knows the newer profile; the finite replica still serves the older head.
  await h.receive(timedProfile(agent, [], 101, "Renamed"));
  await screen.findByRole("heading", { name: "Renamed" });
  const identity = screen.getByRole("region", { name: "Agent identity" });
  await waitFor(() =>
    expect(identity).toHaveTextContent("Not verified — no valid owner"),
  );
  expect(screen.queryByRole("button", ownerButton(a))).toBeNull();
});

it("uses the lower event id between equal-time profiles", async () => {
  const agent = keypair();
  const a = keypair();
  const b = keypair();
  const first = timedProfile(agent, [auth(agent, a)], 100);
  const second = timedProfile(agent, [auth(agent, b)], 100);
  const [low, high] = first.id < second.id ? [first, second] : [second, first];
  const [winner, loser] = low === first ? [a, b] : [b, a];
  const h = live(agent, high);
  await screen.findByRole("button", ownerButton(loser));
  await h.receive(low);
  await screen.findByRole("button", ownerButton(winner));
  await h.receive(high);
  h.rerender();
  expect(screen.getByRole("button", ownerButton(winner))).toBeInTheDocument();
  expect(screen.queryByRole("button", ownerButton(loser))).toBeNull();
});

it("retries a failed archive read from the pane", async () => {
  const agent = keypair();
  const owner = keypair();
  const h = live(agent, timedProfile(agent, [auth(agent, owner)], 100), true);
  const retry = await screen.findByRole("button", {
    name: "Retry agent details",
  });
  const identity = screen.getByRole("region", { name: "Agent identity" });
  expect(identity).toHaveTextContent("ArchiveUnknown");
  h.recoverArchives();
  await userEvent.setup().click(retry);
  await waitFor(() =>
    expect(identity).toHaveTextContent("Archived on this relay"),
  );
  expect(archiveReads(h.query)).toBe(2);
  expect(
    screen.queryByRole("button", { name: "Retry agent details" }),
  ).toBeNull();
});

it("retries a failed archive read once when the profile is reopened", async () => {
  const agent = keypair();
  const owner = keypair();
  const h = live(agent, timedProfile(agent, [auth(agent, owner)], 100), true);
  await screen.findByRole("button", { name: "Retry agent details" });
  // The failure stays visible; no automatic retry loop.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(archiveReads(h.query)).toBe(1);
  h.recoverArchives();
  h.reopen();
  const identity = await screen.findByRole("region", {
    name: "Agent identity",
  });
  await waitFor(() =>
    expect(identity).toHaveTextContent("Archived on this relay"),
  );
  expect(archiveReads(h.query)).toBe(2);
});

it("settles a known agent with no public profile as not verified", async () => {
  const agent = keypair();
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: relayKey.pubkey,
    scope: "wss://relay.example.test",
    query: async () => [],
    media: () => undefined,
    readAgentLibrary: async () => ({
      definitions: [],
      identities: [{ pubkey: agent.pubkey, name: "Unpublished agent" }],
    }),
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  owners.push(owner);
  await owner.session.agentLibrary.refresh();
  let observed: ReturnType<RelaySession["observe"]> | undefined;
  const session: RelaySession = Object.create(owner.session, {
    observe: {
      value: (filters: readonly ReadFilter[]) => {
        observed = owner.session.observe(filters);
        return observed;
      },
    },
  });
  const snapshot = { status: "ready" as const, generation: 1, session };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  render(
    <StrictMode>
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(observed?.snapshot().status).toBe("ready"));
  expect(observed?.snapshot().events).toHaveLength(0);
  const identity = screen.getByRole("region", { name: "Agent identity" });
  await waitFor(() =>
    expect(identity).toHaveTextContent(
      "Not verified — no valid owner attestation.",
    ),
  );
  expect(identity).not.toHaveTextContent("Checking…");
});
