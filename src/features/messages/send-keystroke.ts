import { createDeviceToggle } from "../../shared/device-toggle";
import { matches, type KeyBinding } from "../shortcuts/bindings";
import { isApplePlatform } from "../shortcuts/format";

export const sendWithModEnterPreference = createDeviceToggle({
  storageKey: "buzz-send-with-mod-enter.v1",
  enabledByDefault: false,
});

export const MOD_ENTER: KeyBinding = Object.freeze({ key: "Enter", mod: true });
const PLAIN_ENTER: KeyBinding = Object.freeze({ key: "Enter" });

export type SendKeystroke = Readonly<{
  sends: boolean;
  /** Plain Enter inside a list adds the next item instead of sending. */
  sendsFromLists: boolean;
}>;

export function readSendKeystroke(event: KeyboardEvent): SendKeystroke {
  const requiresModifier = sendWithModEnterPreference.isEnabled();
  const sendBinding = requiresModifier ? MOD_ENTER : PLAIN_ENTER;
  const apple = isApplePlatform(navigator.platform);
  return {
    sends: matches([sendBinding], event, apple),
    sendsFromLists: requiresModifier,
  };
}
