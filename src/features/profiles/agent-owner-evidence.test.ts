import { expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { createAgentOwnerEvidence } from "./agent-owner-evidence";

it("reports exhausted observation capacity as a failure, not as loading", () => {
  const session = {
    observe: () => {
      throw new Error("Relay view capacity unavailable");
    },
    profiles: { subscribe: () => () => {}, event: () => undefined },
  } as unknown as RelaySession;
  const store = createAgentOwnerEvidence(session, "a".repeat(64));
  expect(store.snapshot()).toMatchObject({
    status: "unavailable",
    failed: true,
    owner: undefined,
  });
  // A failed retry reports the same way.
  store.retry();
  expect(store.snapshot().status).toBe("unavailable");
  store.dispose();
});
