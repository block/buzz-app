// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { PENDING, type CommunitySessions, type Credential } from "./session";
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
  // A service made without storage saves choices here.
  localStorage.clear();
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
  const provider = builderlabProvider(session, decide);
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
  const provider = builderlabProvider(session, async () => ({
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
  const provider = builderlabProvider(session, async () => ({
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
  const provider = builderlabProvider(session, async () => {
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
  const provider = builderlabProvider(session, undefined);
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
    },
  }));
  await session.signIn();
  const decide = vi.fn<BuilderlabDecide>();
  const provider = builderlabProvider(session, decide);
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
    },
  }));
  const decide = vi.fn<BuilderlabDecide>();
  const offer = (native: BuilderlabDecide | undefined) =>
    root
      .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
      .plugin((ctx) => offerBuilderlabDecisions(ctx, session, native));
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

it("waits for a restoring sign-in instead of sending a chosen Builderlab's decisions to TypeSafe", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  const answered = {
    outcome: "answered" as const,
    model: "test",
    answers: { a: { type: "yes_no" as const, probability: 0.7 } },
  };
  const typesafe = vi.fn(async () => answered);
  const fallback = root
    .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
    .plugin((ctx) =>
      ctx.decisions.registerProvider({
        id: "typesafe",
        label: "TypeSafe",
        description: "Your key.",
        status: () => "ready",
        subscribe: () => () => {},
        decide: typesafe,
      }),
    );
  // A saved sign-in being restored at launch, as the native session
  // reports it, until `restored` signs in.
  const signedIn = createTestSession(async () => ({
    ...credential("restored"),
    account: {
      ...credential("restored").account,
      canUseBuilderlabDecisions: true,
    },
  }));
  let restoring = true;
  // One snapshot object, as a store's snapshot must be.
  const RESTORING = Object.freeze({
    status: "pending" as const,
    checking: true,
  });
  const listeners = new Set<() => void>();
  const session = {
    ...signedIn,
    snapshot: () => (restoring ? RESTORING : signedIn.snapshot()),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      const stop = signedIn.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  } as unknown as BuilderlabSession;
  const native = vi.fn<BuilderlabDecide>(async () => answered);
  const builderlab = root
    .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
    .plugin((ctx) => offerBuilderlabDecisions(ctx, session, native));
  await Promise.all([fallback.await(), builderlab.await()]);
  await flush();
  const BUILDERLAB = "block.builderlab/builderlab";
  decisions.setBackend(BUILDERLAB, COMMUNITY);
  expect(decisions.backend(COMMUNITY)).toBe(BUILDERLAB);
  expect(decisions.status(COMMUNITY)).toBe("checking");
  // Settings leaves it to the row, which says it is checking.
  const Settings = decisions.providers()[0]?.Settings;
  if (!Settings) throw new Error("Builderlab has settings");
  const view = render(<Settings active={() => true} community={COMMUNITY} />);
  expect(screen.queryByRole("status")).toBeNull();
  view.unmount();
  const reply = decisions.decide({ ...request, community: COMMUNITY });
  await flush();
  expect(typesafe).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
  // The restore finishes signed in, with no browser step in between.
  await signedIn.signIn();
  expect(typesafe).not.toHaveBeenCalled();
  restoring = false;
  for (const listener of [...listeners]) listener();
  await expect(reply).resolves.toMatchObject({
    outcome: "answered",
    backend: BUILDERLAB,
  });
  expect(native).toHaveBeenCalledOnce();
  expect(typesafe).not.toHaveBeenCalled();
  await Promise.all([builderlab.dispose(), fallback.dispose()]);
});

it("waits for a community's sign-in server to be restored before choosing who answers", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  const answered = {
    outcome: "answered" as const,
    model: "test",
    answers: { a: { type: "yes_no" as const, probability: 0.7 } },
  };
  const typesafe = vi.fn(async () => answered);
  const fallback = root
    .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
    .plugin((ctx) =>
      ctx.decisions.registerProvider({
        id: "typesafe",
        label: "TypeSafe",
        description: "Your key.",
        status: () => "ready",
        subscribe: () => () => {},
        decide: typesafe,
      }),
    );
  const block = createTestSession(async () => ({
    ...credential("block"),
    account: {
      ...credential("block").account,
      canUseBuilderlabDecisions: true,
    },
  }));
  // The app's first snapshot at launch: restoring, its server not known.
  let snapshot: Record<string, unknown> = {
    status: "restoring",
    authority: null,
  };
  let answering: BuilderlabSession = block;
  const listeners = new Set<() => void>();
  const identity = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as FederatedIdentity;
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const sessions: CommunitySessions = {
    server: () => undefined,
    forCommunity: () => answering,
    dispose: () => {},
  };
  const known = {
    snapshot: () => ({ memberships: [{ id: COMMUNITY, name: "Example" }] }),
    subscribe: () => () => {},
  } as unknown as KnownCommunities;
  const native = vi.fn<BuilderlabDecide>(async () => answered);
  const builderlab = root
    .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
    .plugin((ctx) =>
      offerBuilderlabDecisions(
        ctx,
        block,
        native,
        undefined,
        communityDecisionSessions(sessions, identity, known),
      ),
    );
  await Promise.all([fallback.await(), builderlab.await()]);
  await flush();
  const BUILDERLAB = "block.builderlab/builderlab";
  decisions.setBackend(BUILDERLAB, COMMUNITY);
  expect(decisions.backend(COMMUNITY)).toBe(BUILDERLAB);
  expect(decisions.status(COMMUNITY)).toBe("checking");
  // A community not joined has no server followed, so none is waited for,
  // even with Builderlab chosen everywhere: it says it cannot answer.
  const ELSEWHERE = "wss://elsewhere.example";
  decisions.setBackend(BUILDERLAB);
  expect(decisions.backend(ELSEWHERE)).toBe(BUILDERLAB);
  expect(decisions.status(ELSEWHERE)).toBe("needs-setup");
  const reply = decisions.decide({ ...request, community: COMMUNITY });
  await flush();
  // Its server is known, but which session answers is not yet.
  snapshot = {
    status: "restoring",
    authority: { id: "relay.example", communityHosts: ["relay.example"] },
  };
  answering = PENDING;
  changed();
  await flush();
  expect(decisions.status(COMMUNITY)).toBe("checking");
  expect(typesafe).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
  await block.signIn();
  answering = block;
  snapshot = { ...snapshot, status: "signed-in" };
  changed();
  await expect(reply).resolves.toMatchObject({
    outcome: "answered",
    backend: BUILDERLAB,
  });
  expect(native).toHaveBeenCalledOnce();
  expect(typesafe).not.toHaveBeenCalled();
  await Promise.all([builderlab.dispose(), fallback.dispose()]);
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
      snapshot: () => ({ authority: { id: hosts[0], communityHosts: hosts } }),
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
  // A community no server covers has no Builderlab; the others use the
  // session of the server that covers them.
  expect(communities.forCommunity(OTHER)).toBeUndefined();
  expect(communities.forCommunity(BLOCK)).toBe(block);
  expect(communities.forCommunity(PUBLIC)).toBe(build);
  const decide = vi.fn<BuilderlabDecide>(async () => ({
    outcome: "answered",
    backend: "builderlab",
    model: "builderlab-1",
    answers: { a: { type: "yes_no", probability: 0.7 } },
  }));
  const opened = vi.fn();
  const fiber = root
    .extend({ pluginOwner: { id: "block.builderlab", revision: "one" } })
    .plugin((ctx) =>
      offerBuilderlabDecisions(
        ctx,
        build,
        decide,
        { label: "Community sign-ins", section: "identity", open: opened },
        communities,
      ),
    );
  await fiber.await();
  await flush();
  const BUILDERLAB = "block.builderlab/builderlab";
  const keys = () => decisions.providers().map((provider) => provider.key);
  // Offered before any sign-in, where a server covers a community, so the
  // user can choose it there.
  expect(keys()).toEqual([BUILDERLAB, DEFAULT_DECISION_PROVIDER]);
  const [offered] = decisions.providers();
  expect(offered?.offered?.(BLOCK)).toBe(true);
  expect(offered?.offered?.(OTHER)).toBe(false);
  // Where it is offered it is the default, and says it cannot answer yet:
  // TypeSafe does not answer in its place.
  expect(decisions.backend(BLOCK)).toBe(BUILDERLAB);
  expect(decisions.status(BLOCK)).toBe("needs-setup");
  // Settings says where to sign in, and does not sign in itself.
  const Settings = offered?.Settings;
  if (!Settings) throw new Error("Builderlab has settings");
  const signedOut = render(<Settings active={() => true} community={BLOCK} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Not signed in to Builderlab for this community. Sign in from Community sign-ins.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Community sign-ins" }));
  expect(opened).toHaveBeenCalledExactlyOnceWith("identity");
  signedOut.unmount();
  // Signed in to Block alone, while the build's server is signed out.
  await block.signIn();
  await build.signIn();
  // Until the user chooses, Builderlab is the default wherever it is
  // offered, and answers only where that account may use decisions.
  expect(decisions.backend(BLOCK)).toBe(BUILDERLAB);
  expect(decisions.status(BLOCK)).toBe("ready");
  expect(decisions.backend(PUBLIC)).toBe(BUILDERLAB);
  expect(decisions.status(PUBLIC)).toBe("needs-setup");
  expect(decisions.backend(OTHER)).toBe(DEFAULT_DECISION_PROVIDER);
  // Settings explains each community's own account.
  const view = render(<Settings active={() => true} community={PUBLIC} />);
  expect(
    screen.getByText(
      "This Builderlab account can’t use decisions. For access, contact your account administrator.",
    ),
  ).toBeVisible();
  view.rerender(<Settings active={() => true} community={BLOCK} />);
  expect(screen.queryByRole("status")).toBeNull();
  view.unmount();
  // Without a community, it is not offered: it bills one. That holds even
  // when its own session could answer, as a choice saved before
  // per-community choices would ask it.
  expect(decisions.providers()[0]?.status()).toBe("needs-setup");
  expect(
    builderlabProvider(block, decide, undefined, communities).status(),
  ).toBe("needs-setup");
  expect(
    builderlabProvider(block, decide, undefined, communities).status(BLOCK),
  ).toBe("ready");
  expect(decisions.providers()[0]?.offered?.()).toBe(false);
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
  expect(decisions.backend(BLOCK)).toBe(BUILDERLAB);
  expect(decisions.status(BLOCK)).toBe("needs-setup");
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
      .plugin((ctx) => offerBuilderlabDecisions(ctx, session, native));
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
      // Signed in without access: listed, and as the default it refuses
      // rather than leaving the request to TypeSafe.
      expect(
        decisions
          .providers()
          .some((p) => p.key === "block.builderlab/builderlab"),
      ).toBe(true);
      await expect(decisions.decide(request)).resolves.toMatchObject(
        entry === "settings-with-choice"
          ? { outcome: "answered", backend: "example.provider/custom" }
          : {
              outcome: "failed",
              backend: "block.builderlab/builderlab",
              reason: "unauthorized",
            },
      );
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
        await waitFor(() => expect(identity.request).toHaveBeenCalledTimes(2));
        if (entry === "settings") expect(menu).toHaveTextContent("Builderlab");
        else {
          await userEvent.click(menu);
          await userEvent.click(
            await screen.findByRole("option", { name: /Builderlab/ }),
          );
        }
        await expect
          .poll(() => decisions.backend(COMMUNITY))
          .toBe("block.builderlab/builderlab");
      } else {
        // The request that notices stale permissions waits for the re-read
        // it starts, and the new grant answers it.
        await expect(decisions.decide(request)).resolves.toMatchObject({
          outcome: "answered",
          backend: "block.builderlab/builderlab",
        });
      }
      expect(
        decisions
          .providers()
          .some((p) => p.key === "block.builderlab/builderlab"),
      ).toBe(true);
      expect(decisions.backend(COMMUNITY)).toBe("block.builderlab/builderlab");
      // TypeSafe never answers in Builderlab's place.
      expect(fallback).not.toHaveBeenCalled();
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
