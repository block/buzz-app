// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionsSettings } from "../../app/DecisionsSettings";
import { federatedFixture } from "../../features/federated-identity/testing";
import { createNativeSession } from "./session";
import { createTestSession } from "./test-helpers";
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_DECISION_PROVIDER,
  DecisionsService,
} from "../../features/decisions/service";
import { flush } from "../../features/relay/testing";
import {
  builderlabProvider,
  communityDecisionSessions,
  nativeBuilderlabDecide,
  offerBuilderlabDecisions,
  type BuilderlabDecide,
} from "./decisions";
import type { CommunitySessions, Credential } from "./session";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import type { KnownCommunities } from "../../features/communities/service";
import type { BuilderlabSession } from "./session";

const credential = (revision: string): Credential => ({
  revision,
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: true,
    canUseHostedTranscription: false,
  },
});
const request = {
  state: "x",
  questions: { a: { type: "yes_no" as const, instructions: "y" } },
  timeoutMs: 30_000,
};
const signal = new AbortController().signal;
const COMMUNITY = "wss://relay.example";
const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(async () => ({})),
}));
vi.mock("@tauri-apps/api/core", () => tauri);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  tauri.isTauri.mockReturnValue(false);
});

it("names the native session by its revision, never a token", async () => {
  tauri.isTauri.mockReturnValue(true);
  await nativeBuilderlabDecide()?.(request, credential("fi-revision"));
  expect(tauri.invoke).toHaveBeenLastCalledWith("decide", {
    backend: "builderlab",
    request,
    federated: "fi-revision",
  });
});

it("needs a sign-in, then sends it to native with each call", async () => {
  const session = createTestSession(async () => credential("first"));
  const decide = vi.fn<BuilderlabDecide>(async () => ({
    outcome: "answered",
    backend: "builderlab",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  }));
  const provider = builderlabProvider(session, true, decide);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "missing_credentials",
  });
  expect(decide).not.toHaveBeenCalled();
  await session.signIn();
  expect(provider.status()).toBe("ready");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "answered",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  });
  expect(decide).toHaveBeenCalledWith(request, session.credential());
});

it("never ends an FI session for a decisions 401", async () => {
  const signOut = vi.fn();
  const fi = {
    revision: "fi-revision",
    storage: "",
    account: credential("x").account,
  };
  const session = {
    snapshot: () => ({ status: "signed-in", account: fi.account }),
    subscribe: () => () => {},
    credential: () => fi,
    signOut,
    freshCredential: async () => fi,
  } as unknown as BuilderlabSession;
  const provider = builderlabProvider(session, true, async () => ({
    outcome: "failed",
    backend: "builderlab",
    reason: "session_expired",
  }));
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(signOut).not.toHaveBeenCalled();
});

it("keeps the shared sign-in when only decisions are refused", async () => {
  const session = createTestSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, true, async () => ({
    outcome: "failed",
    backend: "builderlab",
    reason: "unauthorized",
  }));
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(session.snapshot().status).toBe("signed-in");
});

it.each([
  ["invalid args `request` for command `decide`", "invalid_request"],
  ["decide not allowed", "service_error"],
])("reports a native rejection (%s) as %s", async (message, reason) => {
  const session = createTestSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, true, async () => {
    throw message;
  });
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason,
  });
});

it("is unavailable outside the desktop app", async () => {
  const session = createTestSession(async () => credential("first"));
  await session.signIn();
  const provider = builderlabProvider(session, false, undefined);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unavailable",
  });
});

it("sends nothing to Builderlab unless the account may use decisions", async () => {
  const session = createTestSession(async () => ({
    revision: "first",
    account: {
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
      canUseHostedTranscription: false,
    },
  }));
  await session.signIn();
  const decide = vi.fn<BuilderlabDecide>();
  const provider = builderlabProvider(session, true, decide);
  expect(provider.status()).toBe("needs-setup");
  await expect(provider.decide(request, { signal })).resolves.toEqual({
    outcome: "failed",
    reason: "unauthorized",
  });
  expect(decide).not.toHaveBeenCalled();
});

it("offers Builderlab while signed in, ready only while the account may use decisions", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  let allowed = false;
  const session = createTestSession(async () => ({
    ...credential("first"),
    account: {
      ...credential("first").account,
      canUseBuilderlabDecisions: allowed,
      canUseHostedTranscription: false,
    },
  }));
  const decide = vi.fn<BuilderlabDecide>();
  const offer = (native: BuilderlabDecide | undefined) =>
    root
      .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
      .plugin((ctx) => offerBuilderlabDecisions(ctx, session, true, native));
  const fiber = offer(decide);
  await fiber.await();
  await flush();
  const keys = () => decisions.providers().map((provider) => provider.key);
  expect(keys()).toEqual([]);
  await session.signIn();
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  expect(decisions.status()).toBe("needs-setup");
  session.signOut();
  allowed = true;
  await session.signIn();
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  expect(decisions.backend()).toBe("block.builderlab/builderlab");
  expect(decisions.status()).toBe("ready");
  session.signOut();
  expect(keys()).toEqual([]);
  await session.signIn();
  expect(keys()).toEqual(["block.builderlab/builderlab"]);
  // Turning the plugin off removes it, and a build without native calls
  // never offers it.
  await fiber.dispose();
  expect(keys()).toEqual([]);
  const browser = offer(undefined);
  await browser.await();
  await flush();
  expect(keys()).toEqual([]);
  expect(decide).not.toHaveBeenCalled();
});

it("answers each community with its own sign-in server's account, and leaves the rest to TypeSafe", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  const typesafe = await root
    .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
    .plugin((ctx) =>
      ctx.decisions.registerProvider({
        id: "typesafe",
        label: "TypeSafe",
        description: "Your key.",
        status: () => "ready",
        subscribe: () => () => {},
        decide: async () => ({ outcome: "failed", reason: "unavailable" }),
      }),
    );
  await typesafe.await();
  const allowed = (revision: string, may: boolean) => async () => ({
    ...credential(revision),
    account: {
      ...credential(revision).account,
      canUseBuilderlabDecisions: may,
    },
  });
  // The build's server, which this account may not use decisions on, and
  // Block's, which it may.
  const build = createTestSession(allowed("build", false));
  const block = createTestSession(allowed("block", true));
  const server = (hosts: string[]) =>
    ({
      snapshot: () => ({ authority: { communityHosts: hosts } }),
      subscribe: () => () => {},
    }) as unknown as FederatedIdentity;
  const buildServer = server(["public.example"]);
  const blockServer = server(["block.example"]);
  const BLOCK = "wss://block.example";
  const PUBLIC = "wss://public.example";
  const OTHER = "wss://other.example";
  // Communities list as https origins; agents name them by relay URL.
  const isBlock = (relay: string | undefined) =>
    !!relay && new URL(relay).host === "block.example";
  const sessions: CommunitySessions = {
    server: (relay) => (isBlock(relay) ? blockServer : buildServer),
    forCommunity: (relay) => (isBlock(relay) ? block : build),
    dispose: () => {},
  };
  const known = {
    snapshot: () => ({
      memberships: [PUBLIC, BLOCK, OTHER].map((id) => ({ id, name: id })),
    }),
    subscribe: () => () => {},
  } as unknown as KnownCommunities;
  const communities = communityDecisionSessions(sessions, buildServer, known);
  // A community no server covers has no Builderlab.
  expect(communities.forCommunity(OTHER)).toBeUndefined();
  const decide = vi.fn<BuilderlabDecide>(async () => ({
    outcome: "answered",
    backend: "builderlab",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  }));
  const fiber = root
    .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
    .plugin((ctx) =>
      offerBuilderlabDecisions(
        ctx,
        build,
        true,
        decide,
        undefined,
        communities,
      ),
    );
  await fiber.await();
  await flush();
  const BUILDERLAB = "block.builderlab/builderlab";
  const keys = () => decisions.providers().map((provider) => provider.key);
  expect(keys()).toEqual([DEFAULT_DECISION_PROVIDER]);
  // Signed in to Block alone, while the build's server is signed out.
  await block.signIn();
  expect(keys()).toEqual([BUILDERLAB, DEFAULT_DECISION_PROVIDER]);
  await build.signIn();
  for (const chosen of [undefined, BUILDERLAB]) {
    if (chosen) decisions.setBackend(chosen);
    expect(decisions.backend(BLOCK)).toBe(BUILDERLAB);
    expect(decisions.backend(PUBLIC)).toBe(DEFAULT_DECISION_PROVIDER);
    expect(decisions.backend(OTHER)).toBe(DEFAULT_DECISION_PROVIDER);
  }
  // Without a community, it cannot answer: it bills one.
  expect(decisions.providers()[0]?.status()).toBe("needs-setup");
  expect(decisions.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  await expect(
    decisions.decide({ ...request, community: BLOCK }),
  ).resolves.toMatchObject({ outcome: "answered", backend: BUILDERLAB });
  expect(decide).toHaveBeenCalledExactlyOnceWith(
    { ...request, community: BLOCK },
    block.credential(),
  );
  // Asked directly elsewhere, it sends nothing.
  const [provider] = decisions.providers();
  await expect(
    provider?.decide({ ...request, community: PUBLIC }, { signal }),
  ).resolves.toEqual({ outcome: "failed", reason: "unauthorized" });
  await expect(
    provider?.decide({ ...request, community: OTHER }, { signal }),
  ).resolves.toEqual({ outcome: "failed", reason: "missing_credentials" });
  expect(decide).toHaveBeenCalledOnce();
  block.signOut();
  build.signOut();
  expect(keys()).toEqual([DEFAULT_DECISION_PROVIDER]);
  await fiber.dispose();
});

it.each(["settings", "request", "settings-with-choice"] as const)(
  "picks up newly granted Decisions access through %s without signing in again",
  async (entry) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let allowed = false;
    const identity = federatedFixture();
    identity.request.mockImplementation(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        subject: "user",
        email: "a@example.com",
        capabilities: { can_use_builderlab_decisions: allowed },
      }),
    }));
    const session = createNativeSession(identity.service);
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const decisions = new DecisionsService(root, {
      getItem: () => null,
      setItem: () => {},
    } as unknown as Storage);
    const answered = {
      outcome: "answered" as const,
      model: "test",
      answers: { a: { type: "yes_no" as const, probability: 0.7 } },
    };
    const fallback = vi.fn(async () => answered);
    const native = vi.fn<BuilderlabDecide>(async () => answered);
    const chosen = vi.fn(async () => answered);
    const fallbackPlugin = root
      .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
      .plugin((ctx) =>
        ctx.decisions.registerProvider({
          id: "typesafe",
          label: "TypeSafe",
          description: "Fallback",
          status: () => "ready",
          subscribe: () => () => {},
          decide: fallback,
        }),
      );
    const builderlab = root
      .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
      .plugin((ctx) => offerBuilderlabDecisions(ctx, session, true, native));
    try {
      await Promise.all([fallbackPlugin.await(), builderlab.await()]);
      if (entry === "settings-with-choice") {
        const custom = root
          .extend({ pluginOwner: { id: "example.provider", revision: "one" } })
          .plugin((ctx) =>
            ctx.decisions.registerProvider({
              id: "custom",
              label: "Custom",
              description: "Chosen",
              status: () => "ready",
              subscribe: () => () => {},
              decide: chosen,
            }),
          );
        await custom.await();
        await flush();
        decisions.setBackend("example.provider/custom");
      }
      await session.signIn();
      await expect.poll(() => session.snapshot().status).toBe("signed-in");
      await flush();
      // Signed in without access: listed, but defaults fall through to TypeSafe.
      expect(
        decisions
          .providers()
          .some((p) => p.key === "block.builderlab/builderlab"),
      ).toBe(true);
      const beforeBackend =
        entry === "settings-with-choice"
          ? "example.provider/custom"
          : "buzz.typesafe/typesafe";
      await expect(decisions.decide(request)).resolves.toMatchObject({
        backend: beforeBackend,
      });
      const owner = session.credential();
      expect(identity.request).toHaveBeenCalledOnce();
      // Settings lists the community; with another provider chosen
      // everywhere, the user picks Builderlab for it.
      const memberships = [{ id: COMMUNITY, name: "Example" }];
      const settings = entry.startsWith("settings")
        ? render(
            <DecisionsSettings
              decisions={decisions}
              active={() => false}
              memberships={memberships}
            />,
          )
        : undefined;
      expect(identity.request).toHaveBeenCalledOnce();
      allowed = true;
      now += 60_000;
      if (entry.startsWith("settings")) {
        settings?.rerender(
          <DecisionsSettings
            decisions={decisions}
            active={() => true}
            memberships={memberships}
          />,
        );
        // Showing where Builderlab answers re-reads its permissions.
        const menu = screen.getByRole("combobox", {
          name: "Decision provider for Example",
        });
        if (entry === "settings")
          await waitFor(() => expect(menu).toHaveTextContent("Builderlab"));
        else {
          await waitFor(() =>
            expect(identity.request).toHaveBeenCalledTimes(2),
          );
          await userEvent.click(menu);
          await userEvent.click(
            await screen.findByRole("option", { name: /Builderlab/ }),
          );
        }
        await expect
          .poll(() => decisions.backend(COMMUNITY))
          .toBe("block.builderlab/builderlab");
      } else {
        // TypeSafe can answer now, so the request that notices stale
        // permissions does not wait for them; the re-read it starts makes
        // Builderlab the default for the next one.
        await expect(decisions.decide(request)).resolves.toMatchObject({
          backend: "buzz.typesafe/typesafe",
        });
        await expect
          .poll(() => decisions.backend())
          .toBe("block.builderlab/builderlab");
      }
      expect(
        decisions
          .providers()
          .some((p) => p.key === "block.builderlab/builderlab"),
      ).toBe(true);
      expect(decisions.backend(COMMUNITY)).toBe("block.builderlab/builderlab");
      expect(fallback).toHaveBeenCalledTimes(
        { settings: 1, request: 2, "settings-with-choice": 0 }[entry],
      );
      if (entry === "settings-with-choice")
        expect(native).not.toHaveBeenCalled();
      expect(identity.request).toHaveBeenCalledTimes(2);
      await act(async () => {
        await decisions.decide({ ...request, community: COMMUNITY });
      });
      expect(identity.request).toHaveBeenCalledTimes(2);
      expect(session.credential()).toBe(owner);
      expect(identity.service.signIn).toHaveBeenCalledOnce();
      expect(identity.service.signOut).not.toHaveBeenCalled();
    } finally {
      cleanup();
      await root.fiber.dispose();
      session.dispose();
      clock.mockRestore();
    }
  },
);
