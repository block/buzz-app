// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { provideNavigation } from "../features/navigation/service";
import { NotificationsService } from "../features/notifications/service";
import { NotificationSettings } from "./NotificationSettings";
import { PluginRuntime } from "../plugins/runtime";

const contexts: Context[] = [];
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  localStorage.clear();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "represents development pause=%s without changing saved preferences",
  async (paused) => {
    vi.stubEnv("VITE_BUZZ_NOTIFICATIONS_PAUSED", paused ? "1" : "0");
    const ctx = new Context();
    contexts.push(ctx);
    const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
    ctx.effect(() => () => runtime.dispose());
    let permission: "default" | "granted" = "default";
    const platform = {
      label: "Browser",
      permission: vi.fn(async () => permission),
      requestPermission: vi.fn(async () => {
        permission = "granted";
        return permission;
      }),
      show: vi.fn(async () => {}),
      dispose() {},
    };
    const service = new NotificationsService(
      ctx,
      provideNavigation(ctx).navigation,
      platform,
    );
    service.selectViewer("a".repeat(64));
    service.updatePreferences({ enabled: true });
    const saved = localStorage.getItem(
      `buzz-notification-preferences.v1:${"a".repeat(64)}`,
    );
    render(<NotificationSettings notifications={service} />);
    const toggle = screen.getByRole("switch", { name: "Desktop alerts" });
    if (paused) {
      expect(toggle).toBeDisabled();
      expect(toggle).not.toBeChecked();
      expect(screen.getByRole("status")).toHaveTextContent(
        "BUZZ_DEV_NOTIFICATIONS=1",
      );
      expect(
        screen.queryByRole("button", { name: "Allow notifications" }),
      ).not.toBeInTheDocument();
    } else {
      expect(toggle).toBeEnabled();
      expect(toggle).toBeChecked();
      expect(
        screen.getByRole("button", { name: "Allow notifications" }),
      ).toBeEnabled();
    }
    cleanup();
    await service.requestPermission();
    expect(platform.requestPermission).toHaveBeenCalledTimes(paused ? 0 : 1);
    const accepted = await service.admit(
      "mention",
      "Mentions",
      {
        sourceKey: "test-event",
        target: { version: 1, kind: "settings" },
      },
      () => true,
    );
    expect(accepted).toBe(!paused);
    if (paused) expect(platform.show).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(platform.show).toHaveBeenCalledOnce());
    expect(service.snapshot().preferences.enabled).toBe(true);
    service.reloadPreferences();
    expect(service.snapshot().preferences.enabled).toBe(true);
    expect(
      localStorage.getItem(
        `buzz-notification-preferences.v1:${"a".repeat(64)}`,
      ),
    ).toBe(saved);
  },
);
