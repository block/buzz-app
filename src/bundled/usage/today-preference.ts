import { devicePreference } from "../../features/messages/device-preference";

/** Device-local choice: today's agent spend shows beside Send. Off by default. */
export const {
  usePreference: useSpendBesideSend,
  useSaveError: useSpendBesideSendSaveError,
  set: setSpendBesideSend,
} = devicePreference(
  "buzz-usage-spend-beside-send.v1",
  "buzz-usage-spend-beside-send-changed",
);
