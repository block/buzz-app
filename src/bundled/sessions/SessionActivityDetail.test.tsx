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
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "../../features/conversation/service";
import { PagesService } from "../../features/pages/service";
import { PanelsService } from "../../features/panels/service";
import { provideNavigation } from "../../features/navigation/service";
import * as sessionsPlugin from "./index";
import * as activityPlugin from "../agent-activity/index";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("actual registration passively projects scoped observations, lazily discloses safe text and retires reset evidence", async () => {
  const data = sessionsData({ agentActivity: true });
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async (plugin) =>
    plugin.manifest.id === "buzz.sessions" ? sessionsPlugin : activityPlugin,
  );
  new PagesService(ctx);
  new PanelsService(ctx);
  provideNavigation(ctx, undefined);
  ctx.provide("relay", data.relay);
  const extensions = new ConversationService(ctx);
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
  const user = userEvent.setup();
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
      expect(extensions.channelDirectories.snapshot()).toHaveLength(1),
    );
    const Accessory =
      extensions.channelDirectories.snapshot()[0]?.threadAccessory;
    const rootId = data.rows[0]?.rootId,
      otherRoot = data.rows[1]?.rootId;
    if (!Accessory || !rootId || !otherRoot)
      throw new Error("Missing real contribution/root");
    const mounted = render(
      <Accessory
        session={data.session}
        scope={data.scope}
        channelId="general"
        threadRootId={rootId}
        messages={data.session.channels.window("general").rows}
      />,
      { reactStrictMode: true },
    );
    expect(
      screen.queryByRole("region", { name: "Session agent activity" }),
    ).toBeNull();
    expect(data.report.observerControls).toEqual([]);
    const baseline = {
      queries: data.report.queries.length,
      readers: data.report.readers,
      reading: data.report.readingLeases,
    };
    await act(async () => runtime.reconcile([sessions, activity]));
    await waitFor(() =>
      expect(data.session.agentActivity.snapshot().status).toBe("listening"),
    );
    act(() => {
      data.telemetry("turn_started", [otherRoot], "other");
      data.telemetry("turn_started", [rootId]);
    });
    const region = screen.getByRole("region", {
      name: "Session agent activity",
    });
    const toggle = within(region).getByRole("button", {
      name: "Agent activity",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(region.querySelector("pre")).toBeNull();
    await user.click(toggle);
    expect(within(region).getAllByText("turn_started")).toHaveLength(1);
    const malicious = "<img src=x onerror=alert(1)><script>alert(1)</script>";
    const child = (
      turnId: string,
      payload: unknown,
      channelId: string | null = "general",
    ) => ({ kind: "acp_read", turnId, channelId, payload });
    act(() =>
      data.telemetry("batch", [], "fixture-turn", {
        events: [
          child("other", "PRIVATE OTHER ROOT"),
          child("fixture-turn", malicious),
          child("fixture-turn", "NO INHERIT", null),
          {
            ...child("fixture-turn", {
              events: [child("other", "NESTED PRIVATE")],
            }),
            kind: "batch",
          },
        ],
      }),
    );
    expect(region.querySelector("pre")).toBeNull();
    const details = within(region).getAllByRole("button", {
      name: "Details",
    });
    expect(details).toHaveLength(2);
    await user.click(details[1] as HTMLElement);
    await waitFor(() => expect(region.querySelector("pre")).not.toBeNull());
    expect(region.querySelector("pre")?.textContent).toContain(malicious);
    expect(
      region.querySelector("img, script, [data-message-id], time"),
    ).toBeNull();
    expect(region.textContent).not.toMatch(/PRIVATE|NO INHERIT/);
    expect(
      within(region).getByText(/Projected batch child.*reserialized/),
    ).toBeVisible();
    act(() => data.telemetry("turn_completed"));
    expect(within(region).getByText("Observed turn ended")).toBeVisible();
    act(() => data.telemetry("turn_started", [rootId]));
    expect(
      screen.queryByRole("region", { name: "Session agent activity" }),
    ).toBeNull();
    act(() => data.telemetry("turn_started", [rootId], "fresh"));
    expect(
      screen.getByRole("button", { name: "Agent activity" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(data.report.queries).toHaveLength(baseline.queries);
    expect(data.report.readers).toBe(baseline.readers);
    expect(data.report.readingLeases).toBe(baseline.reading);
    expect(data.report.published).toEqual([]);
    expect(data.report.observerControls).toHaveLength(1);
    await act(async () => runtime.reconcile([sessions]));
    await waitFor(() =>
      expect(data.session.agentActivity.snapshot().status).toBe("disabled"),
    );
    expect(
      screen.queryByRole("region", { name: "Session agent activity" }),
    ).toBeNull();
    await act(async () => runtime.reconcile([sessions, activity]));
    await waitFor(() =>
      expect(data.session.agentActivity.snapshot().status).toBe("listening"),
    );
    act(() => data.telemetry("turn_started", [rootId], "fresh"));
    expect(
      screen.getByRole("button", { name: "Agent activity" }),
    ).toHaveAttribute("aria-expanded", "false");
    await act(async () => data.owner.clearCache());
    expect(
      screen.queryByRole("region", { name: "Session agent activity" }),
    ).toBeNull();
    act(() => data.telemetry("turn_started", [rootId], "after-cache"));
    expect(
      screen.getByRole("button", { name: "Agent activity" }),
    ).toHaveAttribute("aria-expanded", "false");
    act(() => data.revoke());
    expect(
      screen.queryByRole("region", { name: "Session agent activity" }),
    ).toBeNull();
    mounted.unmount();
  } finally {
    cleanup();
    await runtime.dispose();
    await ctx.fiber.dispose();
    data.dispose();
  }
});
