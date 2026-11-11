import { expect, it, vi } from "vitest";
import { agentCandidateTags, agentCandidateMetadata } from "./agent-candidates";
import { createMessages } from "./messages";
import { foldMessages } from "./fold";
import { keypair, signed } from "./testing";
import type { Outbox } from "./outbox";
import type { RelaySession } from "./session";
import { seedAgents } from "../messages/remembered-mentions";
import { shareMessageRows } from "./row-identity";

const a = "1".repeat(64),
  b = "2".repeat(64);
it("preserves the full pool through signed publication, projection and composer reseeding", () => {
  const viewer = keypair(),
    relay = keypair();
  const send = vi.fn((input: Parameters<Outbox["send"]>[0]) => input);
  const messages = createMessages(
    { supports: () => true, send } as unknown as Outbox,
    viewer.pubkey,
    () => undefined,
    () => [],
    () => {},
  );
  messages.send("chat", "Check calendar", [a], [], undefined, [b], {}, [a, b]);
  const template = send.mock.calls[0]?.[0];
  if (!template) throw new Error("Missing sent event");
  const event = signed(viewer, template);
  const rows = foldMessages("chat", relay.pubkey, [event]);
  expect(rows[0]?.mentions).toEqual([a]);
  expect(rows[0]?.agentCandidates).toEqual([a, b]);
  const session = {
    viewer: viewer.pubkey,
    agentChoices: {
      snapshot: () => ({
        complete: true,
        identities: [a, b].map((pubkey) => ({ pubkey })),
      }),
    },
    profiles: { snapshot: () => new Map() },
  } as unknown as RelaySession;
  expect(seedAgents(session, "chat", rows, () => true)).toEqual([a, b]);
  expect(seedAgents(session, "chat", rows, (key) => key !== b)).toEqual([a]);
  const row = rows[0];
  if (!row) throw new Error("Missing folded row");
  const changed = { ...row, agentCandidates: [a] };
  expect(shareMessageRows(rows, [changed])[0]).toBe(changed);
});

it("rejects invalid outgoing pools and ignores malformed incoming metadata", () => {
  expect(() => agentCandidateTags([a], [b])).toThrow("Invalid");
  expect(() => agentCandidateTags([a, a], [a])).toThrow("Invalid");
  expect(
    agentCandidateMetadata({
      tags: [
        ["p", a],
        ["buzz:agent-candidate", b],
      ],
    }),
  ).toEqual({});
  expect(
    agentCandidateMetadata({
      tags: [
        ["p", a],
        ["buzz:agent-candidate", a, "extra"],
      ],
    }),
  ).toEqual({});
});
