import { describe, expect, it } from "vitest";
import type { AttentionObject, AttentionValue } from "../agents/attention";
import {
  documentOf,
  parseDocument,
  planApply,
  revisionOf,
  type AgentDocument,
  type LiveAgent,
} from "./document";

const PUBKEY = "a".repeat(64);
const CHANNEL = "9b353519-0d6a-4c55-9a8e-5d3c8b1f2a10";
const OTHER = "1b353519-0d6a-4c55-9a8e-5d3c8b1f2a10";
const schema = { model: "string", effort: ["low", "high"] } as const;

const object = (slug: string, value: AttentionValue): AttentionObject => ({
  slug,
  value,
  modifiedAt: 1,
});
const agent: LiveAgent = {
  pubkey: PUBKEY,
  relay: "wss://relay.example",
  owner: "b".repeat(64),
  type: "plugin/claude",
  name: "Triage Bot",
  about: "First responder.",
  config: { instructions: "You are Triage Bot.", model: "m", effort: "high" },
  attention: {
    "interest/pages": object("interest/pages", {
      type: "interest",
      instructions: "Confirm the page.",
    }),
    "watch/morning": object("watch/morning", {
      type: "timer",
      interest_id: "pages",
      prompt: "Look.",
      enabled: true,
      interval_secs: 86_400,
      armed_at: 500,
      max_occurrences: null,
      expires_at: null,
    }),
    "watch/new-pages": object("watch/new-pages", {
      type: "event",
      interest_id: "pages",
      enabled: true,
      since: 400,
      channels: [CHANNEL],
      kinds: [9],
    }),
  },
};
const live = documentOf(agent, schema, [{ channel: CHANNEL, role: "member" }]);
const current = { agent, document: live };
const edit = (change: (doc: AgentDocument) => AgentDocument) =>
  parseDocument(JSON.stringify(change(live)));

describe("documentOf", () => {
  it("leaves out runtime state and keeps only synced settings", () => {
    expect(live.settings).toEqual({ model: "m", effort: "high" });
    expect(live.instructions).toBe("You are Triage Bot.");
    expect(live.attention.objects["watch/morning"]).not.toHaveProperty(
      "armed_at",
    );
    expect(live.attention.objects["watch/new-pages"]).not.toHaveProperty(
      "since",
    );
  });

  it("gives equal documents the same revision, whatever their key order", async () => {
    const reordered = JSON.parse(JSON.stringify(live)) as AgentDocument;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    expect(await revisionOf(shuffled as AgentDocument)).toBe(
      await revisionOf(live),
    );
  });
});

describe("parseDocument", () => {
  it("reads back what documentOf wrote", () => {
    expect(parseDocument(JSON.stringify(live))).toEqual(live);
  });

  it("refuses unknown fields and invalid attention", () => {
    expect(() =>
      parseDocument(JSON.stringify({ ...live, skills: [] })),
    ).toThrow("Unknown field in the document: skills");
    expect(() =>
      edit((doc) => ({
        ...doc,
        attention: {
          objects: { "interest/x": { type: "interest" } as never },
        },
      })),
    ).toThrow("interest/x");
  });
});

describe("planApply", () => {
  it("changes nothing for the live document", () => {
    expect(planApply(current, live, schema, 900, true).changes).toEqual([]);
  });

  it("keeps a changed timer's arming time and starts a new one now", () => {
    const desired = edit((doc) => ({
      ...doc,
      attention: {
        objects: {
          ...doc.attention.objects,
          "watch/morning": {
            ...(doc.attention.objects["watch/morning"] as object),
            prompt: "Look again.",
          } as never,
          "watch/evening": {
            ...(doc.attention.objects["watch/morning"] as object),
          } as never,
        },
      },
    }));
    const plan = planApply(current, desired, schema, 900, false);
    expect([...plan.changes].sort()).toEqual([
      "watch/evening",
      "watch/morning",
    ]);
    expect(plan.attention["watch/morning"]).toMatchObject({
      prompt: "Look again.",
      armed_at: 500,
    });
    expect(plan.attention["watch/evening"]).toMatchObject({ armed_at: 900 });
    expect(Object.keys(plan.expected)).toEqual(["watch/morning"]);
  });

  it("deletes what the document leaves out, and leaves channels unless pruning", () => {
    const desired = edit((doc) => ({
      ...doc,
      attention: { objects: {} },
      channels: [{ channel: OTHER, role: "guest" }],
    }));
    const plan = planApply(current, desired, schema, 900, false);
    expect(Object.values(plan.attention)).toEqual([null, null, null]);
    expect(plan.channels).toEqual({
      add: [{ channel: OTHER, role: "guest" }],
      role: [],
      remove: [],
    });
    expect(
      planApply(current, desired, schema, 900, true).channels.remove,
    ).toEqual([CHANNEL]);
  });

  it("plans profile, persona and settings changes", () => {
    const desired = edit((doc) => ({
      ...doc,
      profile: { name: "Triage", about: "" },
      instructions: "You triage.",
      settings: { model: "m", effort: "low" },
    }));
    const plan = planApply(current, desired, schema, 900, false);
    expect(plan.profile).toEqual({ name: "Triage", about: null });
    expect(plan.config).toEqual({
      instructions: "You triage.",
      settings: { model: "m", effort: "low" },
    });
  });

  it("refuses what Buzz can't change from a file", () => {
    const retyped = edit((doc) => ({ ...doc, type: "plugin/codex" }));
    expect(() => planApply(current, retyped, schema, 900, false)).toThrow(
      "Change the agent's type in Buzz first",
    );
    const owner = edit((doc) => ({
      ...doc,
      channels: [{ channel: CHANNEL, role: "owner" }],
    }));
    expect(() => planApply(current, owner, schema, 900, false)).toThrow(
      "not owner",
    );
    const unknown = edit((doc) => ({ ...doc, settings: { voice: "x" } }));
    expect(() => planApply(current, unknown, schema, 900, false)).toThrow(
      'Unknown setting "voice"',
    );
  });
});
