// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type {
  AttentionObject,
  AttentionValue,
  Interest,
} from "../../features/agents/attention";
import type { Agent, AgentChange } from "../../features/agents/service";
import { dream, interestState, interestText } from "./features";
import { restartFeature } from "./save";
import {
  acceptedVersion,
  adopted,
  adoptPlan,
  applyInterest,
  DriftError,
  INTEREST_LIMIT,
  keep,
  LATER_MS,
  type Receipt,
  Receipts,
  type ShownInterest,
  record,
  recover,
  undoable,
} from "./updates";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const DM = "0f0f0f0f-0000-4000-8000-000000000001";
const v2 = dream.timer?.earlier?.[2] ?? "";
const v3 = interestText(dream);
const extra = "Answer in French when the owner writes in French.";
const marked = (version: number, text: string) =>
  `<!-- buzz:bestie/dream.nightly v${version} -->\n${text}\n<!-- /buzz:bestie/dream.nightly -->`;

/** An agent's Attention here, which saves a change as the service does:
 * all of it or, if a shown object changed, none of it. */
function attentionHere(instructions: string, paused = false) {
  let at = 100;
  const objects: Record<string, AttentionObject> = {};
  const put = (slug: string, value: AttentionValue) => {
    objects[slug] = { slug, value, modifiedAt: at++ };
  };
  put("interest/bestie-dream", {
    type: "interest",
    instructions,
    ...(paused && { paused: true }),
  });
  put("watch/bestie-dream", {
    type: "timer",
    interest_id: "bestie-dream",
    prompt: "Nightly review wake",
    enabled: !paused,
    interval_secs: 86_400,
    armed_at: 1_700_000_000,
    max_occurrences: null,
    expires_at: null,
    channel: DM,
  });
  const changes: AgentChange[] = [];
  const save = vi.fn(async (_key: string, change: AgentChange) => {
    changes.push(change);
    for (const [slug, expected] of Object.entries(
      change.attentionExpected ?? {},
    ))
      if (JSON.stringify(objects[slug]) !== JSON.stringify(expected))
        throw new Error("Attention changed. Review it and try again.");
    for (const [slug, value] of Object.entries(change.attention ?? {}))
      if (value) put(slug, value);
      else delete objects[slug];
  });
  return {
    objects,
    changes,
    save,
    agents: { save, types: () => [] },
    /** The agent as the tab shows it now. */
    agent: () =>
      ({
        key: "a".repeat(64),
        pubkey: "a".repeat(64),
        place: "here",
        type: "test/echo",
        attention: { ...objects },
        config: { instructions: "" },
      }) as unknown as Agent,
    /** The agent itself rewriting its Interest, as `interest_set` does. */
    agentWrites(text: string) {
      const live = objects["interest/bestie-dream"]?.value as Interest;
      put("interest/bestie-dream", { ...live, instructions: text });
    },
    live: () => {
      const value = objects["interest/bestie-dream"]?.value;
      return value?.type === "interest" ? value.instructions : "";
    },
  };
}

const receiptsHere = () => new Receipts("community", "a".repeat(64));

it("updates version 2 to 3, saving the receipt first and only the Interest, if it is still the one shown", async () => {
  const here = attentionHere(`${marked(2, v2)}\n\n${extra}`);
  const receipts = receiptsHere();
  const watch = JSON.stringify(here.objects["watch/bestie-dream"]);
  const shown = here.agent();
  let prepared: Receipt | undefined;
  const save = here.save.getMockImplementation();
  here.save.mockImplementationOnce(async (key, change) => {
    // The before-image is saved before Attention is.
    prepared = receipts.list(dream.id)[0];
    await save?.(key, change);
  });
  await applyInterest(
    here.agents,
    shown,
    dream,
    { action: "update" },
    receipts,
  );
  expect(prepared).toMatchObject({ status: "prepared", from: "v2", to: "v3" });
  expect(Object.keys(here.changes[0]?.attention ?? {})).toEqual([
    "interest/bestie-dream",
  ]);
  expect(here.changes[0]?.attentionExpected).toEqual({
    "interest/bestie-dream": shown.attention["interest/bestie-dream"],
  });
  expect(here.live()).toBe(`${v3}\n\n${extra}`);
  // The timer is as it was.
  expect(JSON.stringify(here.objects["watch/bestie-dream"])).toBe(watch);
  const [receipt] = receipts.list(dream.id);
  expect(receipt).toMatchObject({
    action: "update",
    status: "applied",
    accepts: true,
    before: { instructions: `${marked(2, v2)}\n\n${extra}` },
  });
  expect(acceptedVersion(receipts, dream, here.live())).toBe("v3");
});

it("changes nothing when the receipt can't be saved, or the result is too long", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "update" },
      receipts,
    ),
  ).rejects.toThrow("Couldn't save a backup, so nothing was changed.");
  vi.restoreAllMocks();
  expect(here.save).not.toHaveBeenCalled();
  const long = `${v3}\n\n${"x".repeat(INTEREST_LIMIT)}`;
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "adopt", text: long },
      receipts,
    ),
  ).rejects.toThrow("too long to save");
  expect(here.save).not.toHaveBeenCalled();
  expect(receipts.list(dream.id)).toEqual([]);
});

it("marks an update the agent got to first as failed, and saves nothing over it", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  const shown = here.agent();
  here.agentWrites(`${v2}\n\n${extra}`);
  await expect(
    applyInterest(here.agents, shown, dream, { action: "update" }, receipts),
  ).rejects.toThrow("Attention changed");
  expect(here.live()).toBe(`${v2}\n\n${extra}`);
  expect(receipts.list(dream.id)[0]?.status).toBe("failed");
});

it("settles a receipt left prepared from what the Interest holds now", async () => {
  const lost = async (land: boolean) => {
    const here = attentionHere(v2);
    const receipts = receiptsHere();
    const save = here.save.getMockImplementation();
    here.save.mockImplementationOnce(async (key, change) => {
      if (land) await save?.(key, change);
      throw new Error("Timed out.");
    });
    await expect(
      applyInterest(
        here.agents,
        here.agent(),
        dream,
        { action: "update" },
        receipts,
      ),
    ).rejects.toThrow("Timed out.");
    // Neither saved nor refused is known yet.
    expect(receipts.list(dream.id)[0]?.status).toBe("prepared");
    return { here, receipts };
  };
  // A save that landed after its answer was lost.
  const landed = await lost(true);
  recover(landed.receipts, dream, landed.here.agent());
  expect(landed.receipts.list(dream.id)[0]?.status).toBe("applied");
  // One that never landed.
  localStorage.clear();
  const failed = await lost(false);
  recover(failed.receipts, dream, failed.here.agent());
  expect(failed.receipts.list(dream.id)[0]?.status).toBe("failed");
  // Saved, then the app stopped before marking it, then the agent edited
  // it: neither, so the owner reviews it.
  localStorage.clear();
  const drifted = await lost(true);
  drifted.here.agentWrites(`${v3}\n\n${extra}`);
  recover(drifted.receipts, dream, drifted.here.agent());
  const [unresolved] = drifted.receipts.list(dream.id);
  expect(unresolved?.status).toBe("unresolved");
  expect(undoable(drifted.receipts, dream)?.id).toBe(unresolved?.id);
});

it("keeps a good save when only marking its receipt applied fails", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  const save = here.save.getMockImplementation();
  here.save.mockImplementationOnce(async (key, change) => {
    await save?.(key, change);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
  });
  await applyInterest(
    here.agents,
    here.agent(),
    dream,
    { action: "update" },
    receipts,
  );
  vi.restoreAllMocks();
  expect(here.live()).toBe(v3);
  expect(receipts.list(dream.id)[0]?.status).toBe("prepared");
  recover(receipts, dream, here.agent());
  expect(receipts.list(dream.id)[0]?.status).toBe("applied");
});

it("undoes an update, and asks first if the Interest changed since", async () => {
  const here = attentionHere(`${v2}`);
  const receipts = receiptsHere();
  const update = await applyInterest(
    here.agents,
    here.agent(),
    dream,
    { action: "update" },
    receipts,
  );
  // The agent adds a line after the update, outside the markers.
  here.agentWrites(`${v3}\n\n${extra}`);
  const undo = { action: "undo", receipt: update } as const;
  const refused = applyInterest(
    here.agents,
    here.agent(),
    dream,
    undo,
    receipts,
  );
  await expect(refused).rejects.toBeInstanceOf(DriftError);
  expect(here.live()).toBe(`${v3}\n\n${extra}`);
  // Undo anyway puts version 2 back, markers and steps together.
  await applyInterest(
    here.agents,
    here.agent(),
    dream,
    { ...undo, anyway: true },
    receipts,
  );
  expect(here.live()).toBe(v2);
  expect(receipts.list(dream.id)[0]).toMatchObject({
    action: "undo",
    to: "v2",
    accepts: true,
  });
});

it("keeps the Interest paused through recovery and Restore backup", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  const save = here.save.getMockImplementation();
  here.save.mockImplementationOnce(async (key, change) => {
    await save?.(key, change);
    throw new Error("Timed out.");
  });
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "update" },
      receipts,
    ),
  ).rejects.toThrow();
  // Paused, then edited by the agent, before the tab opens again.
  const live = here.objects["interest/bestie-dream"]?.value as Interest;
  here.objects["interest/bestie-dream"] = {
    slug: "interest/bestie-dream",
    value: { ...live, paused: true, instructions: `${v3}\n\n${extra}` },
    modifiedAt: 300,
  };
  recover(receipts, dream, here.agent());
  const receipt = undoable(receipts, dream);
  expect(receipt?.status).toBe("unresolved");
  if (!receipt) return;
  await applyInterest(
    here.agents,
    here.agent(),
    dream,
    { action: "undo", receipt, anyway: true },
    receipts,
  );
  expect(here.objects["interest/bestie-dream"]?.value).toEqual({
    type: "interest",
    instructions: v2,
    paused: true,
  });
  // An Interest restored to one set up by hand accepts no version.
  const handMade = attentionHere(`${v2}\n\n${extra}`);
  const adopt = await applyInterest(
    handMade.agents,
    handMade.agent(),
    dream,
    { action: "adopt", text: v3 },
    receipts,
  );
  await applyInterest(
    handMade.agents,
    handMade.agent(),
    dream,
    { action: "undo", receipt: adopt },
    receipts,
  );
  expect(receipts.list(dream.id)[0]).toMatchObject({
    to: "untracked",
    accepts: false,
  });
});

it("never takes stock text the agent wrote, or a restart, as accepted", async () => {
  const here = attentionHere(v3, true);
  const receipts = receiptsHere();
  expect(interestState(here.live(), dream).state).toBe("current");
  expect(acceptedVersion(receipts, dream, here.live())).toBeUndefined();
  const before = here.objects["interest/bestie-dream"]?.value as Interest;
  await restartFeature(here.agents, here.agent(), dream);
  const after = here.objects["interest/bestie-dream"]?.value as Interest;
  record(receipts, dream, "restart", before, after);
  expect(acceptedVersion(receipts, dream, here.live())).toBeUndefined();
  // Turning it on is a choice, and accepts what it saved.
  record(receipts, dream, "on", null, after);
  expect(acceptedVersion(receipts, dream, here.live())).toBe("v3");
  // Lines added outside the markers keep it accepted; steps changed don't.
  expect(acceptedVersion(receipts, dream, `${v3}\n\n${extra}`)).toBe("v3");
  expect(
    acceptedVersion(receipts, dream, v3.replace("1. READ.", "1. READ FIRST.")),
  ).toBeUndefined();
});

it("restarts a paused Nightly review without changing its steps", async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 12, 14, 30) });
  const text = `${v3}\n\n${extra}`;
  const here = attentionHere(text, true);
  await restartFeature(here.agents, here.agent(), dream);
  const [change] = here.changes;
  expect(change?.restart).toEqual(["watch/bestie-dream"]);
  expect(here.objects["interest/bestie-dream"]?.value).toEqual({
    type: "interest",
    instructions: text,
  });
  const timer = here.objects["watch/bestie-dream"]?.value;
  expect(timer).toMatchObject({ enabled: true, channel: DM });
  expect(
    new Date((timer as { armed_at: number }).armed_at * 1000).getHours(),
  ).toBe(3);
  // With only its timer paused, the Interest isn't saved at all.
  const timerOnly = attentionHere(text);
  const watch = timerOnly.objects["watch/bestie-dream"];
  if (watch?.value.type === "timer")
    timerOnly.objects["watch/bestie-dream"] = {
      ...watch,
      value: { ...watch.value, enabled: false },
    };
  await restartFeature(timerOnly.agents, timerOnly.agent(), dream);
  expect(Object.keys(timerOnly.changes[0]?.attention ?? {})).toEqual([
    "watch/bestie-dream",
  ]);
});

/** Nightly review set up by hand: version 2 lacking a sentence, with two
 * blocks of the owner's own after it. */
const SENTENCE =
  ' Rename a card only by leaving "MOVED TO [[slug]]" at the old slug.';
const OWN = [
  "OWNER NOTES. These win over the steps above:\n- Keep replies under five lines.\n- Never review on weekends.",
  "TRIAL. Count this note as a test only.",
];
const handMade = `${v2.replace(SENTENCE, "")}\n\n${OWN.join("\n\n")}\n`;

it("adopts an Interest set up by hand as one policy: version 3 and the blocks it added", () => {
  expect(v2).toContain(SENTENCE);
  expect(interestState(handMade, dream)).toEqual({
    state: "untracked",
    closest: 2,
  });
  const { closest, parts } = adoptPlan(handMade, dream);
  expect(closest).toBe(2);
  const additions = parts.filter(({ kind }) => kind === "addition");
  expect(additions).toEqual(
    OWN.map((text) => ({ kind: "addition", text, above: false })),
  );
  // The changed step is version 3's text now, never kept beside it, and
  // the owner sees their own line that it replaces.
  expect(parts.filter(({ kind }) => kind === "difference")).toEqual([
    {
      kind: "difference",
      text: expect.stringContaining("5. ORGANIZE THE CARDS."),
      yours: expect.stringContaining("5. ORGANIZE THE CARDS."),
    },
  ]);
  const [difference] = parts.filter(({ kind }) => kind === "difference");
  expect(difference?.text).toContain(SENTENCE.trim());
  expect(difference?.yours).not.toContain(SENTENCE.trim());
  const result = adopted(dream, additions);
  expect(result).toBe(`${v3}\n\n${OWN.join("\n\n")}`);
  expect(interestState(result, dream)).toEqual({
    state: "current",
    version: 3,
  });
  // Nothing of the steps is outside the markers.
  const outside = result.slice(result.indexOf("<!-- /buzz:bestie/"));
  expect(outside).not.toMatch(/\d\. [A-Z]+\./);
  // A block added before the steps stays before them.
  expect(adoptPlan(`${OWN[1]}\n\n${v2}`, dream).parts).toEqual([
    { kind: "addition", text: OWN[1], above: true },
  ]);
});

it("hides an update for 7 days with Later, until a newer version with Keep as is, and keeps the last 10 receipts", () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 12) });
  const receipts = receiptsHere();
  receipts.hide(dream.id, 3, true);
  expect(receipts.hidden(dream.id, 3)).toBe(true);
  expect(receipts.hidden(dream.id, 3, Date.now() + LATER_MS + 1)).toBe(false);
  receipts.hide(dream.id, 3, false);
  expect(receipts.hidden(dream.id, 3, Date.now() + 10 * LATER_MS)).toBe(true);
  expect(receipts.hidden(dream.id, 4)).toBe(false);
  // Scoped to its community and agent.
  expect(new Receipts("other", "a".repeat(64)).hidden(dream.id, 3)).toBe(false);
  receipts.show(dream.id);
  expect(receipts.hidden(dream.id, 3)).toBe(false);
  const interest: Interest = { type: "interest", instructions: v3 };
  for (let index = 0; index < 12; index++)
    record(receipts, dream, "restart", interest, interest);
  record(receipts, { ...dream, id: "other" }, "on", null, interest);
  expect(receipts.list(dream.id)).toHaveLength(10);
  expect(receipts.list("other")).toHaveLength(1);
});

it("offers an Interest whose markers were changed the same way as one set up by hand", () => {
  // Version 2 between markers, its closing line deleted.
  const damaged = `${extra}\n\n<!-- buzz:bestie/dream.nightly v2 -->\n${v2}\n\n${OWN[0]}`;
  expect(interestState(damaged, dream)).toEqual({ state: "edited-markers" });
  // Adopt keeps the owner's blocks and drops what is left of the markers.
  const { parts } = adoptPlan(damaged, dream);
  expect(parts).toEqual([
    { kind: "addition", text: extra, above: true },
    { kind: "addition", text: OWN[0], above: false },
  ]);
  const result = adopted(dream, parts);
  expect(interestState(result, dream)).toEqual({
    state: "current",
    version: 3,
  });
  expect(result.match(/buzz:bestie\/dream\.nightly v/g)).toHaveLength(1);
});

it("saves over only the Interest a dialog was opened on", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  const shown = here.agent().attention[
    "interest/bestie-dream"
  ] as ShownInterest;
  // The agent edits it while the dialog is open.
  here.agentWrites(`${v2}\n\n${extra}`);
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "update" },
      receipts,
      shown,
    ),
  ).rejects.toThrow("Attention changed");
  expect(here.live()).toBe(`${v2}\n\n${extra}`);
  expect(receipts.list(dream.id)[0]).toMatchObject({
    status: "failed",
    before: { instructions: v2 },
  });
  // So Undo anyway can't drop an edit its diff didn't show.
  const update = await applyInterest(
    here.agents,
    here.agent(),
    dream,
    { action: "update" },
    receipts,
  );
  here.agentWrites(`${v3}\n\n${extra}`);
  const seen = here.agent().attention["interest/bestie-dream"] as ShownInterest;
  here.agentWrites(`${v3}\n\n${extra}\n\nA second edit.`);
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "undo", receipt: update, anyway: true },
      receipts,
      seen,
    ),
  ).rejects.toThrow("Attention changed");
  expect(here.live()).toContain("A second edit.");
});

it("keeps the version accepted and a change left unresolved through many restarts", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  const update = await applyInterest(
    here.agents,
    here.agent(),
    dream,
    { action: "update" },
    receipts,
  );
  const interest = here.agent().attention["interest/bestie-dream"]
    ?.value as Interest;
  const left: Receipt = {
    ...update,
    id: "left",
    action: "adopt",
    status: "unresolved",
    accepts: true,
  };
  receipts.put(left);
  for (let count = 0; count < 11; count++)
    record(receipts, dream, "restart", interest, interest);
  const kept = receipts.list(dream.id);
  expect(kept.map(({ id }) => id)).toEqual(
    expect.arrayContaining([update.id, "left"]),
  );
  expect(kept.filter(({ action }) => action === "restart")).toHaveLength(8);
  expect(acceptedVersion(receipts, dream, here.live())).toBe("v3");
});

it("offers the backup of a change left unresolved after an attempt to restore it is refused", async () => {
  const here = attentionHere(v3);
  const receipts = receiptsHere();
  const interest = here.agent().attention["interest/bestie-dream"]
    ?.value as Interest;
  const left: Receipt = {
    id: "left",
    part: dream.id,
    action: "update",
    from: "v2",
    to: "v3",
    before: { ...interest, instructions: v2 },
    after: interest,
    status: "unresolved",
    accepts: true,
    at: 1,
  };
  receipts.put(left);
  const shown = here.agent().attention[
    "interest/bestie-dream"
  ] as ShownInterest;
  here.agentWrites(`${v3}\n\n${extra}`);
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "undo", receipt: left, anyway: true },
      receipts,
      shown,
    ),
  ).rejects.toThrow("Attention changed");
  expect(receipts.list(dream.id)[0]?.status).toBe("failed");
  expect(undoable(receipts, dream)?.id).toBe("left");
});

it("refuses to put this build's version over one a newer Buzz set", async () => {
  const newer = marked(4, "Steps from a newer Buzz.");
  const here = attentionHere(newer);
  const receipts = receiptsHere();
  for (const op of [
    { action: "update" },
    { action: "restore" },
    { action: "adopt", text: v3 },
  ] as const)
    await expect(
      applyInterest(here.agents, here.agent(), dream, op, receipts),
    ).rejects.toThrow("set by a newer Buzz");
  expect(here.live()).toBe(newer);
  expect(here.save).not.toHaveBeenCalled();
  expect(receipts.list(dream.id)).toEqual([]);
});

it("won't undo or restore a backup over a version a newer Buzz set", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  const update = await applyInterest(
    here.agents,
    here.agent(),
    dream,
    { action: "update" },
    receipts,
  );
  const newer = marked(4, "Steps from a newer Buzz.");
  here.agentWrites(newer);
  here.save.mockClear();
  for (const anyway of [false, true])
    await expect(
      applyInterest(
        here.agents,
        here.agent(),
        dream,
        { action: "undo", receipt: update, anyway },
        receipts,
      ),
    ).rejects.toThrow("set by a newer Buzz");
  expect(here.live()).toBe(newer);
  expect(here.save).not.toHaveBeenCalled();
});

it("keeps a change left unresolved settled once the owner keeps it, through many restarts", () => {
  const receipts = receiptsHere();
  const interest: Interest = { type: "interest", instructions: v3 };
  receipts.put({
    id: "left",
    part: dream.id,
    action: "update",
    from: "v2",
    to: "v3",
    before: { type: "interest", instructions: v2 },
    after: interest,
    status: "unresolved",
    accepts: true,
    at: 1,
  });
  expect(undoable(receipts, dream)?.status).toBe("unresolved");
  keep(receipts, dream);
  for (let count = 0; count < 11; count++)
    record(receipts, dream, "restart", interest, interest);
  expect(
    receipts.list(dream.id).some(({ status }) => status === "unresolved"),
  ).toBe(false);
  expect(undoable(receipts, dream)).toBeUndefined();
});

it("settles every change left unresolved when the owner keeps the Interest, so none comes back", async () => {
  const here = attentionHere(v2);
  const receipts = receiptsHere();
  const lost = () => here.save.mockRejectedValueOnce(new Error("timed out"));
  // Update times out, then the agent edits.
  lost();
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "update" },
      receipts,
    ),
  ).rejects.toThrow("timed out");
  here.agentWrites(`${v2}\n\n${extra}`);
  recover(receipts, dream, here.agent());
  const first = undoable(receipts, dream);
  expect(first?.status).toBe("unresolved");
  // Restore backup times out too, and the agent edits again.
  lost();
  await expect(
    applyInterest(
      here.agents,
      here.agent(),
      dream,
      { action: "undo", receipt: first as Receipt, anyway: true },
      receipts,
    ),
  ).rejects.toThrow("timed out");
  here.agentWrites(`${v2}\n\n${extra}\n\nA second edit.`);
  recover(receipts, dream, here.agent());
  expect(
    receipts.list(dream.id).filter(({ status }) => status === "unresolved"),
  ).toHaveLength(2);
  keep(receipts, dream);
  const interest = here.agent().attention["interest/bestie-dream"]
    ?.value as Interest;
  for (let count = 0; count < 11; count++)
    record(receipts, dream, "restart", interest, interest);
  expect(
    receipts.list(dream.id).some(({ status }) => status === "unresolved"),
  ).toBe(false);
  expect(undoable(receipts, dream)).toBeUndefined();
});
