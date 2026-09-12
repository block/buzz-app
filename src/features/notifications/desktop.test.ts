import { Context } from "@deepseek-ai/cordis";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "../../app/NotificationSettings";
import { PluginRuntime } from "../../plugins/runtime";
import { provideNavigation } from "../navigation/service";
import { createNotifications } from "./platform";
import { NotificationsService } from "./service";
import { messageNotificationText } from "./content";

const sdk = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));
const native = vi.hoisted(() => ({ value: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.value }));
vi.mock("@tauri-apps/plugin-notification", () => sdk);
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.resetAllMocks();
  native.value = true;
});
function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const navigation = provideNavigation(ctx).navigation;
  // Exercise the production default, not an injected adapter.
  const service = new NotificationsService(ctx, navigation);
  service.selectViewer("a".repeat(64));
  const submit = (sourceKey: string) =>
    service.admit(
      "mention",
      "Mentions",
      { sourceKey, target: { version: 1, kind: "settings" } },
      () => true,
      () => true,
    );
  return { service, submit };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

it("the default service sends desktop banners via the official SDK and shared policy", async () => {
  const { service, submit } = setup();
  await flush();
  expect(service.snapshot()).toMatchObject({
    permission: "unknown",
    systemManaged: true,
    preferences: { enabled: true },
  });
  expect(sdk.requestPermission).not.toHaveBeenCalled();
  await submit("first");
  await submit("first");
  await flush();
  expect(sdk.sendNotification).toHaveBeenCalledExactlyOnceWith({
    title: "Buzz",
    body: "New mentions",
  });
  service.updatePreferences({ enabled: false });
  await submit("off");
  service.updatePreferences({ enabled: true, categories: { mention: false } });
  await submit("category-off");
  await flush();
  expect(sdk.sendNotification).toHaveBeenCalledTimes(1);
});

it("an explicit permission request uses the SDK without claiming OS permission is known", async () => {
  const { service, submit } = setup();
  sdk.isPermissionGranted.mockResolvedValue(false);
  await service.refreshPermission();
  expect(service.snapshot().permission).toBe("default");
  await submit("pending");
  await flush();
  expect(sdk.sendNotification).not.toHaveBeenCalled();
  sdk.isPermissionGranted.mockResolvedValue(true);
  await service.requestPermission();
  await flush();
  expect(sdk.requestPermission).toHaveBeenCalledOnce();
  expect(service.snapshot().permission).toBe("unknown");
  expect(sdk.sendNotification).toHaveBeenCalledOnce();
});

it("observable SDK failures surface once without retry or a browser fallback", async () => {
  const { service, submit } = setup();
  sdk.sendNotification.mockImplementationOnce(() => {
    throw new Error("SDK unavailable");
  });
  await submit("failed");
  await flush();
  expect(service.snapshot().error).toBe("SDK unavailable");
  await submit("failed");
  await flush();
  expect(sdk.sendNotification).toHaveBeenCalledOnce();
  await submit("next");
  await flush();
  expect(sdk.sendNotification).toHaveBeenCalledTimes(2);
});

it("desktop settings keep master/categories but explain OS sound and click limits", async () => {
  const { service } = setup();
  await flush();
  const html = renderToStaticMarkup(
    createElement(NotificationSettings, { notifications: service }),
  );
  expect(html).toContain("Desktop alerts");
  expect(html).toContain("Mentions");
  expect(html).toContain(
    "Manage sound and permission in system notification settings",
  );
  expect(html).toContain(
    "Desktop banners do not open a specific message when clicked",
  );
  expect(html).not.toContain("<span>Sound</span>");
  expect(html).not.toContain("Permission granted");
});

it("non-Tauri runs select the unchanged browser adapter, never the native SDK", async () => {
  native.value = false;
  const platform = createNotifications();
  expect(platform.label).toBe("Browser notifications");
  expect(await platform.permission()).toBe("unsupported");
  expect(sdk.isPermissionGranted).not.toHaveBeenCalled();
  expect(sdk.sendNotification).not.toHaveBeenCalled();
});

it("the production desktop adapter forwards the message title and preview unchanged", async () => {
  const { service } = setup();
  await service.admit(
    "mention",
    "Mentions",
    { sourceKey: "rich", target: { version: 1, kind: "settings" } },
    () => true,
    () => true,
    () =>
      messageNotificationText(
        {
          channelId: "room",
          messageId: "b".repeat(64),
          authorId: "c".repeat(64),
          createdAt: 1,
          previewContent: "Hello **Wes**",
        },
        "mention",
        { id: "room", name: "Room" },
        { name: "Pinky" },
      ),
  );
  await flush();
  expect(sdk.sendNotification).toHaveBeenCalledExactlyOnceWith({
    title: "Pinky mentioned you in #Room",
    body: "Hello Wes",
  });
});
