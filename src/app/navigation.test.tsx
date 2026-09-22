// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServices, type AppServices } from "./services";
import { useAppNavigation } from "./navigation";
import { communityDestination } from "../features/communities/destination";
import type { OpenTarget } from "../features/navigation/targets";

// Only the installed page and HTTP boundary are fixtures. Exercise the real
// app services, browser-history restoration, React hook and community sessions.
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.page", name: "Test", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "main",
            title: "Test",
            component: () => null,
          });
        },
      },
    },
  ],
}));

const viewer = "a".repeat(64);
const primary = { url: communityDestination("primary").url, name: "Primary" };
const secondary = {
  url: communityDestination("secondary").url,
  name: "Secondary",
};
let shared = primary;
let services: AppServices;
const writes: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  shared = primary;
  writes.length = 0;
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      memberships: [
        { id: "primary", name: "Primary" },
        { id: "secondary", name: "Secondary" },
      ],
      selected: "primary",
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/relay/identity")
        return Response.json({ viewer, startupCommunity: shared });
      if (url === "/api/relay/community-preference") {
        shared = JSON.parse(String(options?.body));
        writes.push(shared);
        return Response.json({});
      }
      if (url.endsWith("/session")) {
        const destination = url.split("/")[3];
        if (!destination) throw new Error("Missing session destination");
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          relayUrl: communityDestination(decodeURIComponent(destination)).url,
        });
      }
      return Response.json([]);
    }),
  );
});

afterEach(async () => {
  cleanup();
  await services?.dispose();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// All fixture requests resolve immediately. Drain their microtask chains and
// React effects at a controlled clock boundary before asserting absent writes.
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

it.each(["primary", null] as const)(
  "restores history scope %s locally without replacing an explicit shared choice",
  async (restored) => {
    const target: OpenTarget = {
      version: 1,
      kind: "page",
      pluginId: "test.page",
      pageId: "main",
      scope: restored ? { viewer, communityOrigin: primary.url } : null,
    };
    window.history.replaceState(
      null,
      "",
      `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
    );
    services = createServices();
    await settle();
    expect(services.communities.snapshot().selected).toBe("primary");
    const primarySession = services.relay.snapshot();
    expect(primarySession.status).toBe("ready");
    expect(writes).toEqual([]);

    // A newer explicit choice must survive this older restored route.
    services.communities.select("secondary");
    await settle();
    expect(shared).toMatchObject(secondary);
    expect(writes).toHaveLength(1);
    expect(services.relay.snapshot().session).not.toBe(primarySession.session);

    const hook = renderHook(() => useAppNavigation(services));
    await settle();
    expect(hook.result.current.failure).toBeUndefined();
    expect(hook.result.current.waiting).toBe(false);
    expect(hook.result.current.request?.target).toEqual(target);
    expect(services.communities.snapshot().selected).toBe(restored);
    expect(
      JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null")
        .selected,
    ).toBe(restored);
    if (restored)
      expect(services.relay.snapshot().session).toBe(primarySession.session);
    else expect(services.relay.snapshot().status).toBe("disconnected");
    expect(writes).toHaveLength(1);
    expect(shared).toMatchObject(secondary);

    // Simulate a new port's empty storage, not a live window following changes.
    hook.unmount();
    await services.dispose();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    services = createServices();
    await settle();
    expect(services.communities.snapshot().selected).toBe("secondary");
    expect(writes).toHaveLength(1);

    // Completed opens and subsequent explicit choices still update the hint.
    services.communities.joined(
      { id: "primary", name: "Primary" },
      { name: "Local", picture: "" },
    );
    await settle();
    expect(shared).toMatchObject(primary);
    expect(writes).toHaveLength(2);
    services.communities.select("secondary");
    await settle();
    expect(shared).toMatchObject(secondary);
    expect(writes).toHaveLength(3);
  },
);
