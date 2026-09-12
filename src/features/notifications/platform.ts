import { isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type NotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "unknown";
export type NotificationPresentation = Readonly<{
  id: string;
  title: string;
  body: string;
  silent: boolean;
}>;
export interface NotificationPlatform {
  readonly label: string;
  readonly systemManaged?: boolean;
  permission(): Promise<NotificationPermissionState>;
  requestPermission(): Promise<NotificationPermissionState>;
  show(
    item: NotificationPresentation,
    activate: () => void,
    failed: (error: Error) => void,
  ): Promise<void>;
  dispose(): void;
}

/** Official desktop plugin; browser callbacks are not supported by its shim. */
export function createNotifications(): NotificationPlatform {
  if (!isTauri()) return createBrowserNotifications();
  return {
    label: "Desktop notifications",
    systemManaged: true,
    // The desktop plugin reports API availability, not the OS user's permission.
    permission: async () =>
      (await isPermissionGranted()) ? "unknown" : "default",
    async requestPermission() {
      const permission = await requestPermission();
      return permission === "granted" ? "unknown" : permission;
    },
    async show(item) {
      // The public SDK is fire-and-forget. No click callback, delivery receipt,
      // withdrawal or portable sound override is promised by this desktop path.
      sendNotification({ title: item.title, body: item.body });
    },
    dispose() {},
  };
}

/** Running-tab alerts. Native delivery never falls back to a WebView API. */
export function createBrowserNotifications(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
): NotificationPlatform {
  const api =
    host && !isTauri() && "Notification" in host
      ? (host as Window & { Notification: typeof Notification }).Notification
      : undefined;
  const active = new Map<string, Notification>();
  function release(id: string, notification: Notification) {
    notification.onclick = null;
    notification.onclose = null;
    notification.onerror = null;
    active.delete(id);
  }
  function retire(id: string, notification: Notification) {
    release(id, notification);
    notification.close();
  }
  return {
    label: isTauri()
      ? "Native notifications unavailable in this build"
      : "Browser notifications",
    permission: async () => api?.permission ?? "unsupported",
    requestPermission: () =>
      api ? api.requestPermission() : Promise.resolve("unsupported"),
    async show(item, activate, failed) {
      if (api?.permission !== "granted")
        throw new Error("Notification permission is not granted");
      // Closing the oldest presentation also retires its callback; never strand
      // an open banner by independently evicting its only navigation target.
      if (active.size >= 128) {
        const first = active.entries().next().value;
        if (first) retire(...first);
      }
      const notification = new api(item.title, {
        body: item.body,
        tag: item.id,
        silent: item.silent,
      });
      active.set(item.id, notification);
      notification.onclick = () => {
        host?.focus();
        activate();
        retire(item.id, notification);
      };
      notification.onclose = () => release(item.id, notification);
      notification.onerror = () => {
        retire(item.id, notification);
        failed(new Error("The browser could not display a notification."));
      };
    },
    dispose() {
      for (const [id, item] of active) retire(id, item);
    },
  };
}
