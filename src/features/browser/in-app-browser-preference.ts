import type { DeviceSetting } from "../../shared/device-settings";
import { devicePreference } from "../messages/device-preference";

/** Device-local choice to open links in the system browser, not Buzz's own. Off by default. */
export const inAppBrowserDisabled = devicePreference(
  "buzz-in-app-browser-disabled.v1",
  "buzz-in-app-browser-disabled-changed",
);

/** Turning the in-app browser off as a device setting. */
export const inAppBrowserSetting: DeviceSetting = {
  key: "browser.in_app_disabled",
  description:
    "Opens links in your system browser instead of Buzz's in-app browser.",
  schema: { type: "boolean" },
  applies: "To links opened afterwards, on a Mac. Tabs already open stay open.",
  read: () => ({
    value: inAppBrowserDisabled.read(),
    unsaved: inAppBrowserDisabled.saveError(),
  }),
  write: (value) => void inAppBrowserDisabled.set(value as boolean),
};
