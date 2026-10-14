import { expect, it } from "vitest";
import type { OutgoingEvent } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import { isDefinitiveCanvasConflict } from "./canvas-conflict";

const viewer = keypair();

it.each([
  [40100, "failed", "conflict: the relay state changed", true],
  [30078, "failed", "conflict: the relay state changed", false],
  [40100, "unknown", "conflict: the relay state changed", false],
  [40100, "failed", "Retry blocked: conflict: the relay state changed", false],
  [40100, "failed", undefined, false],
] as const)(
  "classifies kind=%s delivery=%s error=%s as definitive=%s",
  (kind, delivery, error, expected) => {
    const operation: OutgoingEvent = {
      event: signed(viewer, { kind, content: "Draft", tags: [] }),
      delivery,
      error,
    };
    expect(isDefinitiveCanvasConflict(operation)).toBe(expected);
  },
);

it("does not classify missing delivery evidence as a refusal", () => {
  expect(isDefinitiveCanvasConflict(undefined)).toBe(false);
});
