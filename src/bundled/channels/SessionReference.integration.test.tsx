// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "../../features/conversation/service";
import { PagesService } from "../../features/pages/service";
import { PanelsService } from "../../features/panels/service";
import { TemplateProvidersService } from "../../features/channel-templates/provider";
import { provideNavigation } from "../../features/navigation/service";
import { message, keypair } from "../../features/relay/testing";
import {
  referenceMarkdown,
  sessionReference,
} from "../../features/sessions/session-reference";
import * as sessionsPlugin from "../sessions/index";
import * as linksPlugin from "../links/index";
import { ChannelsPage } from "./ChannelsPage";

// DOM layout is not under test here; keep all message rows mounted. Browser
// journeys own virtualized geometry. Navigation, plugins and readers stay real.
vi.mock("virtua", () => ({
  Virtualizer: ({ children }: { children: ReactNode }) => <ol>{children}</ol>,
}));
const releases: (() => Promise<void>)[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  for (const release of releases.splice(0)) await release();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "a published Session reference opens its ordinary thread with Sessions enabled=%s, including without Links",
  async (enabled) => {
    const data = sessionsData({ canonicalScope: true, rowCount: 1 });
    const ctx = new Context();
    const runtime = new PluginRuntime(ctx, async (plugin) =>
      plugin.manifest.id === "buzz.sessions" ? sessionsPlugin : linksPlugin,
    );
    const pages = new PagesService(ctx);
    const panels = new PanelsService(ctx);
    const providers = new TemplateProvidersService(ctx);
    const conversation = new ConversationService(ctx);
    const host = provideNavigation(ctx);
    ctx.provide("relay", data.relay);
    releases.push(async () => {
      data.dispose();
      await runtime.dispose();
      await ctx.fiber.dispose();
    });
    const info = (id: string) => ({
      manifest: { id, name: id, apiVersion: 1 as const },
      enabled: true,
      source: "bundled" as const,
      revision: "one",
      previous: null,
      error: null,
      reloadable: false,
    });
    const sessions = info("buzz.sessions"),
      links = info("buzz.links");
    runtime.reconcile(enabled ? [sessions, links] : [links]);
    const rootId = data.rows[0]?.rootId;
    if (!rootId) throw new Error("Missing fixture root");
    const scope = {
      viewer: data.viewer,
      communityOrigin: "https://sessions.example",
    };
    // This is a received, signed reference. No live send or producer-specific route.
    const reference = sessionReference(
      scope,
      "general",
      rootId,
      "Release checklist",
    );
    data.session.channels.ensureList();
    await waitFor(() =>
      expect(data.session.channels.list().status).toBe("ready"),
    );
    data.ingest([
      message(
        keypair(),
        "general",
        referenceMarkdown(reference) ?? "",
        data.now + 10,
      ),
    ]);
    void host.navigation.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "general",
    });
    const bindings = new Set<ReturnType<typeof host.request>>();
    releases.push(async () => {
      for (const binding of bindings) binding.dispose();
    });
    function App() {
      const state = useSyncExternalStore(
        host.navigation.subscribe,
        host.navigation.snapshot,
      );
      const bound = useMemo(() => {
        const next = host.request(state.attempt, {
          valid: () => true,
          subscribe: () => () => {},
        });
        bindings.add(next);
        return next;
      }, [state.attempt]);
      return (
        <ChannelsPage
          relay={data.relay}
          panels={panels}
          providers={providers}
          pages={pages}
          extensions={conversation}
          navigator={host.navigation}
          navigation={bound.request}
        />
      );
    }
    render(<App />, { reactStrictMode: true });
    const link = await screen.findByRole("link", { name: reference.label });
    await waitFor(() =>
      expect(host.navigation.snapshot().status).toBe("opened"),
    );
    expect(link).toHaveAttribute("href", reference.href);
    expect(!!screen.queryByRole("tab", { name: "Sessions" })).toBe(enabled);
    fireEvent.click(link);
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    await within(thread).findByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    );
    await waitFor(() =>
      expect(host.navigation.snapshot().status).toBe("opened"),
    );
    expect(host.navigation.snapshot().entry.target).toMatchObject({
      kind: "conversation",
      channelId: "general",
      messageId: rootId,
      threadRootId: rootId,
    });
    expect(
      within(thread).getByRole("textbox", { name: "Reply to thread" }),
    ).toBeInTheDocument();
    expect(data.report.published).toEqual([]);
    // Optional presentation removal must neither change the target nor replace its reader.
    const readers = data.report.readers;
    await act(async () => runtime.reconcile([]));
    await waitFor(() => expect(conversation.links.snapshot()).toHaveLength(0));
    expect(screen.getByRole("complementary", { name: "Thread" })).toBe(thread);
    expect(data.report.readers).toBe(readers);
    expect(
      screen.queryByRole("tab", { name: "Sessions" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Thread tab" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Thread" }),
      ).not.toBeInTheDocument(),
    );
    const plain = await screen.findByRole("link", { name: reference.label });
    expect(plain).not.toHaveAttribute("data-link-renderer");
    fireEvent.click(plain);
    const reopened = await screen.findByRole("complementary", {
      name: "Thread",
    });
    await within(reopened).findByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    );
    expect(data.report.published).toEqual([]);
  },
);
