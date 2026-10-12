import { vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { Host, HostRequest } from "../../features/host/service";
import type { ClientSnapshot } from "../../features/communities/service";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import {
  PublishRejected,
  type OutgoingEvent,
} from "../../features/relay/outbox";
import { relayPartition } from "../../features/relay/partition";
import { matchesEvent } from "../../features/relay/projection";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySnapshot } from "../../features/relay/service";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { createAgentClient } from "../builderlab/agents/client";
import { createEnrollment } from "../builderlab/agents/enrollment";
import { createOAuthSession } from "../builderlab/oauth/session";
import { deferred } from "../builderlab/test-helpers";
import { createRemoteBestie } from "./setup";

export const COMMUNITY = "https://community.example";
export const HOME = "11111111-1111-4111-8111-111111111111";
export const cleanups: (() => Promise<void> | void)[] = [];

/** Real client/enrollment/session/outbox; the host and relay wire are controlled. */
export async function bestieFixture() {
  const identity = keypair();
  const authority = keypair();
  const remote = keypair();
  let account = "owner-account";
  const login = createOAuthSession(async () => ({
    value: `credential:${account}`,
    account: { subject: account, email: "owner@example.com" },
  }));
  await login.signIn();
  let row:
    | {
        agent_id: string;
        agent_name: string;
        agent_pubkey: string;
        status: number;
      }
    | undefined;
  let instructions = "";
  let existingAgents: {
    agent_id: string;
    agent_name: string;
    agent_pubkey: string;
    status: number;
  }[] = [];
  const holds = new Map<string, Promise<void>>();
  const request = vi.fn(async (input: HostRequest) => {
    const path = new URL(input.url).pathname.split("/").at(-1) ?? "";
    const body = JSON.parse(input.body ?? "{}");
    const hold = holds.get(path);
    holds.delete(path);
    if (hold) await hold;
    let result: object;
    if (path === "list-agents")
      result = { status: 1, agents: row ? [row] : existingAgents };
    else if (path === "register-agent") {
      row = {
        agent_id: "remote-bestie",
        agent_name: body.agent_name,
        agent_pubkey: remote.pubkey,
        status: 1,
      };
      result = { ...row, status: 1 };
    } else if (path === "attest-agent") {
      const agent =
        row ??
        existingAgents.find(
          (agent) => agent.agent_pubkey === body.agent_pubkey,
        );
      if (!agent) throw new Error("No registered agent");
      agent.status = 2;
      result = { status: 1 };
    } else if (path === "update-agent") {
      instructions = body.agent_instructions;
      result = {};
    } else throw new Error(`Unexpected Builderlab endpoint: ${path}`);
    return { status: 200, headers: {}, body: JSON.stringify(result) };
  });
  const authorize = vi.fn(
    async () => ["auth", identity.pubkey, "", "ab".repeat(64)] as const,
  );
  const host: Host = {
    request,
    prepareRemoteAgentAuthorization: authorize,
    runCommand: async () => null,
  };
  const channels = new Map<
    string,
    { members: string[]; visibility: "open" | "private" }
  >();
  let extraMember: string | undefined;
  let visibility: "open" | "private" | undefined;
  let clock = 1_700_000_000;
  let failKind: number | undefined;
  let rejected = false;
  let applyBeforeFailure = false;
  const events: RelayEvent[] = [];
  const hidden = new Set<string>();
  let saved: readonly OutgoingEvent[] = [];
  let closed = deferred<void>();
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    [
      ...events.filter((event) => !hidden.has(event.id)),
      ...[...channels]
        .filter(
          ([id]) =>
            !events.some(
              (event) =>
                event.kind === 9007 &&
                hidden.has(event.id) &&
                event.tags.some(
                  ([name, value]) => name === "h" && value === id,
                ),
            ),
        )
        .flatMap(([id, home]) => [
          metadata(authority, id, "Bestie", clock, [
            [home.visibility === "private" ? "private" : "public"],
            ["t", "stream"],
          ]),
          roster(authority, id, home.members, clock),
          signed(authority, {
            kind: 39001,
            created_at: clock,
            content: "",
            tags: [
              ["d", id],
              ["p", identity.pubkey, "admin"],
            ],
          }),
        ]),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter))),
  );
  const sign = vi.fn(async (event: EventTemplate) => signed(identity, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    const fail = failKind === event.kind;
    if (fail && !applyBeforeFailure) {
      failKind = undefined;
      throw rejected
        ? new PublishRejected("Rejected")
        : new Error("Receipt lost");
    }
    events.push(event);
    const tag = (name: string) =>
      event.tags.find(([key]) => key === name)?.[1] ?? "";
    if (event.kind === 9007)
      channels.set(tag("h"), {
        members: [identity.pubkey, ...(extraMember ? [extraMember] : [])],
        visibility: visibility ?? (tag("visibility") as "open" | "private"),
      });
    if (event.kind === 9000) channels.get(tag("h"))?.members.push(tag("p"));
    clock++;
    if (fail) {
      failKind = undefined;
      // The relay applied the command, but readback has not caught up yet.
      hidden.add(event.id);
      throw new Error("Receipt lost");
    }
  });
  const start = () =>
    createRelaySession(
      {
        viewer: identity.pubkey,
        relayAuthor: authority.pubkey,
        scope: COMMUNITY,
        media: () => undefined,
        query,
        writer: { kinds: [9, 9000, 9007, 30177], sign, publish },
      },
      {
        outboxStorage: {
          load: () => structuredClone(saved),
          save: (next) => {
            saved = structuredClone(next);
          },
          close: () => closed.resolve(),
        },
      },
    );
  let owner = start();
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer: identity.pubkey,
    scope: relayPartition(COMMUNITY, identity.pubkey),
    session: owner.session,
  };
  let community: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: identity.pubkey,
    selected: COMMUNITY,
    memberships: [],
    profile: { name: "", picture: "", about: "" },
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const reader = { snapshot: () => community, subscribe: relay.subscribe };
  const builderlab = {
    login,
    loginAvailable: true,
    loginUnavailableReason: "",
    agents: createAgentClient(
      host,
      login,
      () => community.selected ?? undefined,
    ),
    enrollment: createEnrollment(relay, reader, login),
  };
  const bestie = createRemoteBestie(builderlab, relay);
  cleanups.push(async () => {
    owner.dispose();
    await closed.promise;
    login.dispose();
    listeners.clear();
  });
  cleanups.push(() => bestie.dispose());
  return {
    bestie,
    builderlab,
    relay,
    request,
    query,
    communityReader: reader,
    authorize,
    sign,
    publish,
    events,
    channels,
    get session() {
      return owner.session;
    },
    viewer: identity.pubkey,
    agent: remote.pubkey,
    instructions: () => instructions,
    customize: (value: string) => {
      instructions = value;
    },
    requests: (path: string) =>
      request.mock.calls.filter(([input]) => input.url.endsWith(`/${path}`)),
    existingBesties() {
      existingAgents = [remote, keypair()].map((agent, index) => ({
        agent_id: `existing-${index}`,
        agent_name: "Bestie",
        agent_pubkey: agent.pubkey,
        status: 2,
      }));
      return existingAgents;
    },
    holdRequest(path: string) {
      const gate = deferred<void>();
      holds.set(path, gate.promise);
      return gate;
    },
    failPublication(kind: number, definite = false, apply = false) {
      failKind = kind;
      rejected = definite;
      applyBeforeFailure = apply;
    },
    revealReceived() {
      hidden.clear();
    },
    unsafeHome(change: "open" | "member") {
      if (change === "open") visibility = "open";
      else extraMember = keypair().pubkey;
      for (const home of channels.values()) {
        if (change === "open") home.visibility = "open";
        else if (extraMember) home.members.push(extraMember);
      }
      clock++;
    },
    setCommunity(selected: string | null) {
      community = { ...community, selected };
      for (const listener of listeners) listener();
    },
    addCommunity() {
      community = {
        ...community,
        memberships: [{ id: COMMUNITY, name: "Test community" }],
      };
      for (const listener of listeners) listener();
    },
    async setAccount(subject: string) {
      login.signOut();
      account = subject;
      await login.signIn();
    },
    async restart() {
      await owner.session.outbox?.ready();
      owner.dispose();
      await closed.promise;
      closed = deferred<void>();
      owner = start();
      snapshot = {
        ...snapshot,
        session: owner.session,
        generation: snapshot.generation + 1,
      };
      for (const listener of listeners) listener();
      await owner.session.outbox?.ready();
    },
  };
}
