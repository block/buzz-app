// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { ComposerSession } from "./composer-session";
import {
  rememberedMentions,
  seedMentions,
  seedEvidenceSettled,
} from "./remembered-mentions";

const a = "a".repeat(64),
  b = "b".repeat(64);
afterEach(() => localStorage.clear());
it("retains a routed pool in inline follow-ups and reseeding for shared Solo chats", () => {
  const identities = [
    { pubkey: a, name: "Calendar" },
    { pubkey: b, name: "Writer" },
  ];
  const session = {
    profiles: { snapshot: () => new Map() },
    agentChoices: { snapshot: () => ({ complete: true, identities }) },
  } as unknown as ComposerSession;
  const row = { mentions: [a], agentCandidates: [a, b] };
  const restored = seedMentions(session, row);
  expect(restored.recipients.map(({ pubkey }) => pubkey)).toEqual([a, b]);
  expect(
    rememberedMentions(session, restored, row.agentCandidates).recipients,
  ).toHaveLength(2);
  expect(seedEvidenceSettled(session, row)).toBe(true);
  localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  expect(seedMentions(session, row).recipients).toEqual([]);
});
