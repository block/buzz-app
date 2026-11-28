import type { DeviceSetting } from "../../shared/device-settings";
import { devicePreference } from "./device-preference";

/** Device-local choice: typed emoticons such as :) become emoji. On by default. */
export const emoticonPreference = devicePreference(
  "buzz-convert-emoticons.v1",
  "buzz-convert-emoticons-changed",
  { enabledByDefault: true },
);

export const emoticonSetting: DeviceSetting = {
  key: "conversations.emoticons",
  description: "Turns typed emoticons such as :) into emoji in messages.",
  schema: { type: "boolean" },
  read: () => ({
    value: emoticonPreference.read(),
    unsaved: emoticonPreference.saveError(),
  }),
  write: (value) => emoticonPreference.set(value as boolean),
};
