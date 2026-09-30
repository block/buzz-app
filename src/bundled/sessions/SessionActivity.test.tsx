// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "../../features/conversation/service";
import { PanelsService } from "../../features/panels/service";
import { PagesService } from "../../features/pages/service";
import { provideNavigation } from "../../features/navigation/service";
import { createRetainedSessions } from "./retained-sessions";
import { SessionActivity } from "./SessionActivity";
import * as sessionsPlugin from "./index";
import * as activityPlugin from "../agent-activity/index";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("actual plugin callers consume owner-only correlation passively; working/unknown/end leave unread, order and readers unchanged", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T14:00:00Z"));
  const data = sessionsData({ agentActivity: true });
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async (plugin) =>
    plugin.manifest.id === "buzz.sessions" ? sessionsPlugin : activityPlugin,
  );
  new PagesService(ctx);
  provideNavigation(ctx, undefined);
  ctx.provide("relay", data.relay);
  const conversation = new ConversationService(ctx);
  new PanelsService(ctx);
  const manifest = (id: string) => ({
    manifest: { id, name: id, apiVersion: 1 as const },
    enabled: true,
    source: "bundled" as const,
    revision: "one",
    previous: null,
    error: null,
    reloadable: false,
  });
  const sessions = manifest("buzz.sessions"),
    activity = manifest("buzz.agent-activity");
  try {
    data.session.channels.ensureList();
    await waitFor(() =>
      expect(data.session.channels.list().status).toBe("ready"),
    );
    data.session.channels.ensure("general");
    await waitFor(() =>
      expect(data.session.channels.window("general").status).toBe("ready"),
    );
    await act(async () => runtime.reconcile([sessions]));
    await waitFor(() =>
      expect(conversation.channelDirectories.snapshot()).toHaveLength(1),
    );
    const registration = conversation.channelDirectories.snapshot()[0];
    if (!registration?.sidebar)
      throw new Error("Missing real Sessions registration");
    const Directory = registration.component,
      Sidebar = registration.sidebar;
    const props = {
      session: data.session,
      scope: data.scope,
      channelId: "general",
      channelName: "General",
      openThread: () => true,
    };
    render(
      <>
        <Directory {...props} />
        <Sidebar
          {...props}
          directorySelected={true}
          openDirectory={() => true}
        />
      </>,
      { reactStrictMode: true },
    );
    const directory = screen.getByRole("region", {
      name: "Sessions",
    });
    const personal = screen.getByRole("region", {
      name: "Your sessions in General",
    });
    await within(directory).findByRole("button", {
      name: /Review the release checklist/,
    });
    await waitFor(() =>
      expect(
        within(directory).queryByText("Checking threads for agents…"),
      ).toBeNull(),
    );
    expect(data.session.agentActivity.snapshot().status).toBe("disabled");
    expect(data.report.observerControls).toEqual([]);
    const first = () =>
      within(directory).getByRole("button", {
        name: /Review the release checklist/,
      });
    const sibling = () =>
      within(directory).getByRole("button", {
        name: /Explore the onboarding flow/,
      });
    const child = () =>
      within(personal).getByRole("button", {
        name: /Review the release checklist/,
      });
    const rootId = data.rows[0]?.rootId;
    if (!rootId) throw new Error("Missing root");
    const order = within(directory).getAllByRole("button"),
      sidebarOrder = within(personal).getAllByRole("button");
    const reads = data.report.queries.length,
      readers = data.report.readers,
      reading = data.report.readingLeases;
    const unread = data.session.unread.snapshot({
      kind: "thread",
      channelId: "general",
      rootId,
    });
    await act(async () => runtime.reconcile([sessions, activity]));
    await waitFor(() =>
      expect(data.session.agentActivity.snapshot().status).toBe("listening"),
    );
    act(() => data.telemetry("turn_started", [rootId]));
    const working = "Owner-visible agent activity: working";
    expect(within(first()).getByRole("img", { name: working })).toBeVisible();
    expect(within(child()).getByRole("img", { name: working })).toBeVisible();
    expect(within(sibling()).queryByRole("img", { name: working })).toBeNull();
    expect(
      within(first()).getByRole("img", { name: /Observed unread/ }),
    ).toBeVisible();
    vi.setSystemTime(new Date("2026-09-21T14:00:31Z"));
    // A non-liveness frame publishes the controlled time without refreshing the
    // turn. Timer-boundary permutations belong to the activity service tests.
    act(() => data.telemetry("diagnostic"));
    expect(
      within(first()).getByRole("img", {
        name: "Owner-visible agent activity: status unknown",
      }),
    ).toBeVisible();
    act(() => data.telemetry("turn_liveness"));
    expect(within(first()).getByRole("img", { name: working })).toBeVisible();
    act(() => data.telemetry("turn_completed"));
    expect(first().querySelector("[data-session-activity]")).toBeNull();
    expect(child().querySelector("[data-session-activity]")).toBeNull();
    expect(within(directory).getAllByRole("button")).toEqual(order);
    expect(within(personal).getAllByRole("button")).toEqual(sidebarOrder);
    expect(
      data.session.unread.snapshot({
        kind: "thread",
        channelId: "general",
        rootId,
      }),
    ).toBe(unread);
    expect(data.report.queries).toHaveLength(reads);
    expect(data.report.readers).toBe(readers);
    expect(data.report.readingLeases).toBe(reading);
    expect(data.report.published).toEqual([]);
    expect(data.report.observerControls).toHaveLength(1);
    act(() => data.telemetry("turn_started", [rootId], "next"));
    expect(within(first()).getByRole("img", { name: working })).toBeVisible();
    vi.useRealTimers();
    await act(async () => runtime.reconcile([sessions]));
    await waitFor(() =>
      expect(data.session.agentActivity.snapshot().status).toBe("disabled"),
    );
    expect(first().querySelector("[data-session-activity]")).toBeNull();
    expect(data.report.observerControls.at(-1)).toBeNull();
    expect(data.report.observerControls).toHaveLength(2);
  } finally {
    cleanup();
    await runtime.dispose();
    await ctx.fiber.dispose();
    data.dispose();
  }
});

it("real session disable, access/cache reset and replacement retire the exact-root indicator", async () => {
  const data = sessionsData({ agentActivity: true }),
    next = sessionsData({ agentActivity: true });
  const retained = createRetainedSessions();
  const rootId = data.rows[0]?.rootId;
  if (!rootId) throw new Error("Missing root");
  let release = () => {};
  try {
    data.session.channels.ensureList();
    await waitFor(() =>
      expect(data.session.channels.list().status).toBe("ready"),
    );
    data.session.channels.ensure("general");
    await waitFor(() =>
      expect(data.session.channels.window("general").status).toBe("ready"),
    );
    release = data.session.agentActivity.activate();
    data.telemetry("turn_started", [rootId]);
    const show = (session = data.session) => (
      <SessionActivity
        evidence={retained.forSession(session)}
        channelId="general"
        rootId={rootId}
      />
    );
    const view = render(show(), { reactStrictMode: true });
    const working = () =>
      screen.queryByRole("img", {
        name: "Owner-visible agent activity: working",
      });
    expect(working()).toBeVisible();
    view.rerender(show(next.session));
    expect(working()).toBeNull();
    act(() => data.telemetry("turn_liveness"));
    expect(working()).toBeNull();
    view.rerender(show());
    expect(working()).toBeVisible();
    await act(async () => data.owner.clearCache());
    expect(working()).toBeNull();
    expect(data.session.agentActivity.snapshot().turns).toEqual([]);
    act(() => data.session.channels.ensureList());
    await waitFor(() =>
      expect(data.session.channels.list().status).toBe("ready"),
    );
    act(() => data.session.channels.ensure("general"));
    await waitFor(() =>
      expect(data.session.channels.window("general").status).toBe("ready"),
    );
    act(() => data.telemetry("turn_started", [rootId], "after-clear"));
    expect(working()).toBeVisible();
    act(() => data.revoke());
    expect(working()).toBeNull();
    act(() => data.telemetry("turn_started", [rootId], "denied"));
    expect(working()).toBeNull();
    act(() => release());
    expect(data.session.agentActivity.snapshot().status).toBe("disabled");
    act(() => data.telemetry("turn_started", [rootId], "disabled"));
    expect(working()).toBeNull();
  } finally {
    cleanup();
    release();
    retained.dispose();
    data.dispose();
    next.dispose();
  }
});
