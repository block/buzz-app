import { expect, it } from "vitest";
import { recordingDefault } from "./relay-default";

it("reads on only from an explicit NIP-11 value", () => {
  expect(recordingDefault({ plugin_recording_default: "on" })).toBe(true);
  expect(recordingDefault({ plugin_recording_default: "off" })).toBe(false);
  expect(recordingDefault({ plugin_recording_default: true })).toBe(false);
  expect(recordingDefault({})).toBe(false);
});
