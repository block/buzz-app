import { devicePreference } from "../../features/messages/device-preference";

/** Device-local choice: today's agent spend shows beside Send. On by default,
 * so it appears as soon as Usage is enabled; turning it off is saved. */
export const {
  usePreference: useSpendBesideSend,
  useSaveError: useSpendBesideSendSaveError,
  set: setSpendBesideSend,
} = devicePreference(
  "buzz-usage-spend-beside-send.v1",
  "buzz-usage-spend-beside-send-changed",
  true,
);
