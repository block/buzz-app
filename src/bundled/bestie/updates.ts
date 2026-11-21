import { diffLines } from "diff";
import {
  type AttentionObject,
  type Interest,
  interestSlug,
} from "../../features/agents/attention";
import type { Agent } from "../../features/agents/service";
import {
  closestVersion,
  type Feature,
  interestState,
  interestText,
  shippedSteps,
  updatedInterest,
} from "./features";
import type { FeatureAgents } from "./save";

/** The most an Interest's instructions can be, as Attention checks them. */
export const INTEREST_LIMIT = 16_384;
/** How long Later hides an update. */
export const LATER_MS = 7 * 24 * 60 * 60 * 1000;
/** Receipts kept for each feature. */
const KEPT = 10;

/** A record of one change the owner made to a feature's Interest here:
 * the whole Interest before and after, so Undo puts back its markers and
 * steps together. `accepts` is whether it installs a version the owner
 * chose, which is what makes that version accepted on this device. */
export type Receipt = Readonly<{
  id: string;
  part: string;
  action: "on" | "update" | "adopt" | "restore" | "undo" | "restart";
  /** Version labels, as `v2`, or `untracked`. */
  from: string;
  to: string;
  before: Interest | null;
  after: Interest;
  /** `kept`: left unresolved, then kept as it was by the owner. */
  status: "prepared" | "applied" | "failed" | "unresolved" | "kept";
  accepts: boolean;
  at: number;
}>;

type Stored = {
  version: 1;
  receipts: Receipt[];
  /** By feature: the version not to offer, and until when; none is until a
   * newer version ships. */
  hidden: Record<string, { version: number; until?: number }>;
};

/** The receipts and hidden updates of one agent in one community, on this
 * device. Each read is from storage, so two tabs agree. */
export class Receipts {
  readonly key: string;
  constructor(community: string, agent: string) {
    this.key = `buzz.bestie.updates.v1:${community}:${agent}`;
  }
  private read(): Stored {
    try {
      const stored = JSON.parse(localStorage.getItem(this.key) ?? "null");
      if (stored?.version === 1 && Array.isArray(stored.receipts))
        return { hidden: {}, ...stored };
    } catch {}
    return { version: 1, receipts: [], hidden: {} };
  }
  private write(stored: Stored) {
    localStorage.setItem(this.key, JSON.stringify(stored));
  }
  /** The feature's receipts, newest first. */
  list(part: string) {
    return this.read()
      .receipts.filter((receipt) => receipt.part === part)
      .reverse();
  }
  /** Saves `receipt`, keeping the last 10 of its feature, and beside them
   * the latest that accepted a version and each one left unresolved, which
   * say what the owner chose and what is still theirs to review. Throws if
   * it can't be saved. */
  put(receipt: Receipt) {
    const stored = this.read();
    const others = stored.receipts.filter(({ id }) => id !== receipt.id);
    const own = [
      ...others.filter(({ part }) => part === receipt.part),
      receipt,
    ];
    const accepted = [...own]
      .reverse()
      .find(({ accepts, status }) => accepts && status === "applied");
    const trimmed = own.filter(
      (kept) => kept !== accepted && kept.status !== "unresolved",
    );
    const drop = new Set(
      trimmed.slice(0, Math.max(0, own.length - KEPT)).map(({ id }) => id),
    );
    this.write({
      ...stored,
      receipts: [...others.filter(({ id }) => !drop.has(id)), receipt],
    });
  }
  /** Sets a saved receipt's status, where it is. */
  mark(id: string, status: Receipt["status"]) {
    const stored = this.read();
    this.write({
      ...stored,
      receipts: stored.receipts.map((receipt) =>
        receipt.id === id ? { ...receipt, status } : receipt,
      ),
    });
  }
  hidden(part: string, version: number, now = Date.now()) {
    const hidden = this.read().hidden[part];
    return (
      hidden?.version === version &&
      (hidden.until === undefined || hidden.until > now)
    );
  }
  /** Hides the feature's update to `version`: for 7 days with `later`,
   * otherwise until a newer version ships. */
  hide(part: string, version: number, later: boolean) {
    const stored = this.read();
    this.write({
      ...stored,
      hidden: {
        ...stored.hidden,
        [part]: { version, ...(later && { until: Date.now() + LATER_MS }) },
      },
    });
  }
  show(part: string) {
    const stored = this.read();
    const { [part]: _, ...hidden } = stored.hidden;
    this.write({ ...stored, hidden });
  }
}

const plain = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
const same = (a: string, b: string) => plain(a) === plain(b);
const label = (text: string, feature: Feature) => {
  const state = interestState(text, feature);
  return "version" in state ? `v${state.version}` : "untracked";
};

export type ShownInterest = AttentionObject & { value: Interest };

/** The feature's Interest on `agent`, as the switch shows it. */
export function liveInterest(agent: Agent, feature: Feature) {
  const object = feature.timer
    ? agent.attention[interestSlug(feature.timer.id)]
    : undefined;
  return object?.value.type === "interest"
    ? (object as ShownInterest)
    : undefined;
}

/** The version the owner accepted here, from the latest receipt that
 * installed one, if its Interest is still what is there between the
 * markers. Text outside them doesn't count. */
export function acceptedVersion(
  receipts: Receipts,
  feature: Feature,
  live: string,
) {
  const receipt = receipts
    .list(feature.id)
    .find(({ accepts, status }) => accepts && status === "applied");
  if (!receipt) return undefined;
  const markers = (text: string) => {
    const opening = /<!-- buzz:bestie\/\S+ v\d+ -->/.exec(text)?.[0];
    const start = opening ? text.indexOf(opening) + opening.length : -1;
    const end = text.lastIndexOf("<!-- /buzz:bestie/");
    return opening && end > start
      ? `${opening}\n${plain(text.slice(start, end))}`
      : undefined;
  };
  const accepted = markers(receipt.after.instructions);
  return accepted && accepted === markers(live) ? receipt.to : undefined;
}

/** The latest receipt Undo can take back: one that changed the steps, not
 * a restart, saved or of unknown outcome. A save that was refused changed
 * nothing, so the one before it is still the latest. */
export function undoable(receipts: Receipts, feature: Feature) {
  const receipt = receipts
    .list(feature.id)
    .find(({ action, status }) => action !== "restart" && status !== "failed");
  return receipt &&
    ["update", "adopt", "restore", "undo"].includes(receipt.action) &&
    receipt.before &&
    (receipt.status === "applied" || receipt.status === "unresolved")
    ? receipt
    : undefined;
}

/** One part of an Interest set up by hand, against the version it is
 * closest to: lines it adds, which Adopt can keep, or lines of that version
 * it changes or lacks, which the new version's text replaces. */
export type AdoptPart = Readonly<{
  kind: "addition" | "difference";
  text: string;
  /** For an addition: whether it comes before the version's steps. */
  above?: boolean;
  /** For a difference: the lines that took its place, which the new
   * version's text replaces too. */
  yours?: string;
}>;

/** How `text`, set up by hand, would become the latest version: the
 * version it is closest to, and its parts, each addition a block of lines
 * set apart by blank lines. */
export function adoptPlan(text: string, feature: Feature) {
  const closest = closestVersion(text, feature);
  const steps = shippedSteps(feature, closest) ?? "";
  // Markers of a version this build doesn't have are no one's lines.
  const lines = text.replace(/^.*<!-- \/?buzz:bestie\/.*-->.*$/gm, "");
  const changes = diffLines(`${plain(steps)}\n`, `${plain(lines)}\n`);
  const parts: AdoptPart[] = [];
  let seen = false;
  changes.forEach((change, index) => {
    if (!change.added && !change.removed) {
      if (change.value.trim()) seen = true;
      return;
    }
    // Lines that take the place of others change the version; they aren't
    // kept beside its text.
    if (change.added && !changes[index - 1]?.removed) {
      for (const block of change.value.split(/\n[ \t]*\n/))
        if (block.trim())
          parts.push({ kind: "addition", text: plain(block), above: !seen });
      return;
    }
    const next = changes[index + 1];
    if (change.removed && (change.value.trim() || next?.added))
      parts.push({
        kind: "difference",
        text: plain(change.value),
        ...(next?.added && next.value.trim() && { yours: plain(next.value) }),
      });
  });
  return { closest, parts };
}

/** The latest version, with the additions in `keep` above or below it. */
export function adopted(feature: Feature, keep: readonly AdoptPart[]) {
  const above = keep.filter((part) => part.above).map(({ text }) => text);
  const below = keep.filter((part) => !part.above).map(({ text }) => text);
  return [...above, interestText(feature), ...below].join("\n\n");
}

export const bytes = (text: string) => new TextEncoder().encode(text).length;

/** What the owner chose to do to a feature's Interest. Update, Restore and
 * Take version N put the latest steps between the markers; Adopt saves
 * `text`; Undo, and Restore backup of an unresolved receipt, put back the
 * receipt's before-image. */
export type InterestOp =
  | Readonly<{ action: "update" | "restore" }>
  | Readonly<{ action: "adopt"; text: string }>
  | Readonly<{ action: "undo"; receipt: Receipt; anyway?: boolean }>;

export class DriftError extends Error {
  constructor(readonly live: ShownInterest) {
    super("It has changed since you updated it.");
  }
}
const CONFLICT = "Attention changed. Review it and try again.";
/** Receipts whose save is under way here, which recovery leaves alone. */
const saving = new Set<string>();

/** Changes the feature's Interest as `op` says, keeping its pause, title
 * and summary. The receipt, with the whole Interest before and after, is
 * saved first, and nothing is changed if it can't be; Attention is then
 * saved only if the Interest is still the one shown. A save refused as
 * changed marks it failed; one whose outcome isn't known leaves it to
 * `recover`. Undo of an Interest changed since is refused with
 * `DriftError` unless `anyway`. */
export async function applyInterest(
  agents: FeatureAgents,
  agent: Agent,
  feature: Feature,
  op: InterestOp,
  receipts: Receipts,
  /** The Interest the owner was shown, as a dialog opened on it: the change
   * is worked out from it and saved only if it is still there. */
  shown?: ShownInterest,
) {
  const live = shown ?? liveInterest(agent, feature);
  if (!live) throw new Error(`${feature.title} is partly saved.`);
  const current = live.value.instructions;
  // A version this build doesn't have is a newer Buzz's to change, Undo
  // and Restore backup too.
  if (interestState(current, feature).state === "ahead")
    throw new Error(
      `${feature.title} was set by a newer Buzz. Update Buzz to change it here.`,
    );
  let instructions: string;
  if (op.action === "undo") {
    const before = op.receipt.before;
    if (!before) throw new Error("No backup on this device.");
    if (!op.anyway && !same(current, op.receipt.after.instructions))
      throw new DriftError(live);
    instructions = before.instructions;
  } else
    instructions =
      op.action === "adopt" ? op.text : updatedInterest(current, feature);
  const size = bytes(instructions);
  if (size > INTEREST_LIMIT)
    throw new Error(
      `This would make ${feature.title} too long to save (${Math.ceil(size / 1024)} KB of 16 KB). Remove some kept lines first.`,
    );
  const after: Interest = { ...live.value, instructions };
  const to = label(instructions, feature);
  const receipt: Receipt = {
    id: crypto.randomUUID(),
    part: feature.id,
    action: op.action,
    from: label(current, feature),
    to,
    before: live.value,
    after,
    status: "prepared",
    accepts: op.action !== "undo" || to !== "untracked",
    at: Date.now(),
  };
  try {
    receipts.put(receipt);
  } catch {
    throw new Error("Couldn't save a backup, so nothing was changed.");
  }
  saving.add(receipt.id);
  try {
    await agents.save(agent.key, {
      attention: { [live.slug]: after },
      attentionExpected: { [live.slug]: live },
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === CONFLICT)
      mark(receipts, receipt.id, "failed");
    throw cause;
  } finally {
    saving.delete(receipt.id);
  }
  mark(receipts, receipt.id, "applied");
  return receipt;
}

/** A receipt's status, set if storage lets it: the save it records has
 * already happened or not. */
function mark(receipts: Receipts, id: string, status: Receipt["status"]) {
  try {
    receipts.mark(id, status);
  } catch {}
}

/** Records a change saved another way, as turning the feature on or
 * restarting it, which was saved whole or not at all. */
export function record(
  receipts: Receipts,
  feature: Feature,
  action: "on" | "restart",
  before: Interest | null,
  after: Interest,
) {
  try {
    receipts.put({
      id: crypto.randomUUID(),
      part: feature.id,
      action,
      from: before ? label(before.instructions, feature) : "off",
      to: label(after.instructions, feature),
      before,
      after,
      status: "applied",
      accepts: action === "on",
      at: Date.now(),
    });
  } catch {}
}

/** Keep current: the owner keeps the Interest as it is now, which settles
 * every change of the feature still left unresolved, not only the latest,
 * so none comes back once a later one is trimmed away. Throws if storage
 * refuses. */
export function keep(receipts: Receipts, feature: Feature) {
  for (const receipt of receipts.list(feature.id))
    if (receipt.status === "unresolved") receipts.mark(receipt.id, "kept");
}

/** Settles each receipt of the feature left prepared, as by a crash or a
 * lost answer, from the Interest there now: its after-image means it was
 * saved, its before-image that it wasn't, and anything else is unresolved,
 * for the owner to review. */
export function recover(receipts: Receipts, feature: Feature, agent: Agent) {
  const live = liveInterest(agent, feature)?.value.instructions;
  for (const receipt of receipts.list(feature.id)) {
    if (receipt.status !== "prepared" || saving.has(receipt.id)) continue;
    const status =
      live !== undefined && same(live, receipt.after.instructions)
        ? "applied"
        : live !== undefined &&
            receipt.before &&
            same(live, receipt.before.instructions)
          ? "failed"
          : "unresolved";
    mark(receipts, receipt.id, status);
  }
}
