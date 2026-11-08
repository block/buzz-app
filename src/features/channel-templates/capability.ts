import type { RelayReader } from "../relay/reader";
import { isTransientFailure } from "../relay/errors";
import type { RelayEvent, ReadFilter } from "../relay/events";
import type { Outbox, LocalEvents } from "../relay/outbox";
import type { ChannelKitHost } from "./host";
import type { ChannelSummary } from "../relay/contracts";
import {
  CanvasConflictError,
  isDefinitiveCanvasConflict,
} from "./canvas-conflict";
import {
  LIVE_CANVAS_BYTES,
  LIVE_CANVAS_LIMIT,
  coordinate,
  KIT_TAG,
  ME_KIT_TAG,
  kitTag,
  parseKitRecord,
  type KitEntry,
  type KitRecord,
  type KitValue,
} from "./model";
import { CANVAS_HISTORY_PAGE } from "./canvas-limits";
import { TEAM_MANIFEST_TAG } from "./team-payload";
import { approvedCanvas, CANVAS_INSTRUCTIONS } from "./canvas-approval";

export type CanvasHistoryCursor = { until: number; before_id: string };
export type CanvasHistoryPage = {
  revisions: readonly RelayEvent[];
  next: CanvasHistoryCursor | undefined;
};

export const selectedHead = <T extends Pick<RelayEvent, "created_at" | "id">>(
  events: readonly T[],
) =>
  [...events].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )[0];
/** A verified signature does not bind a query result to the requested Canvas. */
function isChannelCanvas(event: RelayEvent, channel: string) {
  if (event.kind !== 40100) return false;
  const tags = event.tags.filter((tag) => tag[0] === "h");
  return tags.length === 1 && tags[0]?.length === 2 && tags[0][1] === channel;
}
type Snapshot = {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  entries: readonly KitEntry[];
  error?: string | undefined;
  /** Set with an error that a later retry can fix; see isTransientFailure. */
  transient?: true | undefined;
};
/** Session-owned reads and narrow recipe operations; the existing outbox owns delivery. */
export function createChannelKit({
  host,
  reader,
  outbox,
  local,
  ready,
  viewer,
  community,
  signal,
  canWrite,
  canRead = canWrite,
  delivered,
}: {
  host: ChannelKitHost | undefined;
  reader: RelayReader;
  outbox: Outbox | undefined;
  local: LocalEvents | undefined;
  ready: Promise<void> | undefined;
  viewer: string;
  community: string;
  signal: AbortSignal;
  canWrite(channel: string): boolean;
  canRead?(channel: string): boolean;
  delivered(id: string, active?: () => boolean): Promise<void>;
}) {
  let state: Snapshot = { status: host ? "idle" : "unavailable", entries: [] };
  let pending: Promise<void> | undefined;
  let saving = false;
  let epoch = 0;
  const listeners = new Set<() => void>();
  const update = (next: Snapshot) => {
    signal.throwIfAborted();
    state = next;
    listeners.forEach((l) => {
      l();
    });
  };
  const fresh = (filters: readonly ReadFilter[], readSignal = signal) =>
    reader.read(filters, { signal: readSignal, fresh: true });
  // The newest head this window has read for each record, and the head each of
  // its saves replaces. The final publication check compares the two.
  const observed = new Map<string, Pick<RelayEvent, "created_at" | "id">>();
  const expectations = new Map<string, string | null>();
  const stale = new Set<string>();
  function observe(events: readonly RelayEvent[], generation: number) {
    if (generation !== epoch) return;
    for (const event of events) {
      const d = event.tags.find((t) => t[0] === "d")?.[1];
      if (event.kind !== 30078 || event.pubkey !== viewer || !d) continue;
      const old = observed.get(d);
      if (!old || selectedHead([event, old])?.id === event.id)
        observed.set(d, { id: event.id, created_at: event.created_at });
    }
  }
  const STALE =
    "This record changed before the save was sent; read it again. Nothing was sent.";
  // Keep private instructions out of journal metadata. The existing journal
  // binds the fingerprint to the encrypted event and original expected head.
  async function recoveryKey(d: string, intent: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([viewer, community, d, intent])),
    );
    return `kit-owner:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }
  /** `after: true` never joins a read that began before this call, so the
   * result reflects every change visible when the caller asked. */
  async function refresh({ after = false } = {}) {
    if (!host) return;
    if (pending && after) await pending;
    if (pending) return pending;
    const generation = epoch;
    // A loaded catalog stays ready while it revalidates in the background.
    if (state.status !== "ready")
      update({
        ...state,
        status: "loading",
        error: undefined,
        transient: undefined,
      });
    pending = (async () => {
      try {
        const events = await fresh([
          {
            kinds: [30078],
            authors: [viewer],
            "#t": [KIT_TAG, TEAM_MANIFEST_TAG, ME_KIT_TAG],
            limit: 500,
          },
        ]);
        observe(events, generation);
        if (events.length >= 500)
          throw new Error(
            "Recipe catalog reached its read limit; no partial catalog will be used",
          );
        const heads = new Map<string, RelayEvent>();
        for (const event of events) {
          const d = event.tags.find((t) => t[0] === "d")?.[1];
          if (
            !d ||
            ![KIT_TAG, TEAM_MANIFEST_TAG, ME_KIT_TAG].some((tag) =>
              d?.startsWith(`${tag}:${encodeURIComponent(community)}:`),
            ) ||
            // Retired personal groups: ignore saved records, never reject the catalog.
            d === `${KIT_TAG}:${encodeURIComponent(community)}:groups:personal`
          )
            continue;
          const old = heads.get(d);
          if (!old || selectedHead([event, old])?.id === event.id)
            heads.set(d, event);
        }
        const rows = [...heads.values()],
          entries: KitEntry[] = [];
        for (let start = 0; start < rows.length; start += 16) {
          const batch = rows.slice(start, start + 16);
          const decoded = await host.decode(batch, signal);
          if (!Array.isArray(decoded) || decoded.length !== batch.length)
            throw new Error("Incomplete private recipe decode");
          for (const row of decoded) {
            const event = batch.find((e) => e.id === row.eventId);
            const record = parseKitRecord(row.record, community);
            if (
              !event ||
              event.tags.find((t) => t[0] === "d")?.[1] !== coordinate(record)
            )
              throw new Error("Recipe decode mismatch");
            entries.push({
              record,
              eventId: event.id,
              createdAt: event.created_at,
            });
          }
        }
        // A portable record supersedes an ordinary record for the same team.
        const portable = new Set(
          entries.flatMap((entry) =>
            entry.record.version === 2 ? [entry.record.value.id] : [],
          ),
        );
        const current = entries.filter(
          (entry) =>
            entry.record.version === 2 ||
            entry.record.value.type !== "team" ||
            !portable.has(entry.record.value.id),
        );
        if (generation === epoch) update({ status: "ready", entries: current });
      } catch (error) {
        if (!signal.aborted && generation === epoch)
          update({
            ...state,
            status: "error",
            error: String(error),
            transient: isTransientFailure(error) || undefined,
          });
      } finally {
        if (generation === epoch) pending = undefined;
      }
    })();
    return pending;
  }
  async function confirm(id: string, active?: () => boolean) {
    try {
      if (active && !active())
        throw new DOMException(
          "The call ended before confirmation",
          "AbortError",
        );
      if (
        (await fresh([{ ids: [id], limit: 1, consistency: "strong" }])).some(
          (e) => e.id === id,
        )
      )
        return;
      const saved = local?.snapshot().find((e) => e.event.id === id);
      if (!saved || Date.now() / 1000 - saved.event.created_at >= 15 * 60)
        throw new SaveSettled(
          "This operation could not be confirmed and is too old to replay. Keep your draft and inspect the current result before making a new save.",
        );
      // A proven Canvas CAS refusal cannot become valid by replaying these bytes.
      if (isDefinitiveCanvasConflict(saved)) throw new Error(saved.error);
      await delivered(id, active);
      if (
        !(await fresh([{ ids: [id], limit: 1, consistency: "strong" }])).some(
          (e) => e.id === id,
        )
      )
        throw new Error(
          "Save is awaiting exact relay confirmation; your draft is kept",
        );
    } catch (error) {
      const failed = local?.snapshot().find((item) => item.event.id === id);
      if (outbox && isDefinitiveCanvasConflict(failed)) {
        // Refused before mutation. Release the pending gate, not uncertain saves.
        await outbox.dismiss(id);
        throw new CanvasConflictError();
      }
      throw error;
    }
  }
  /** One replaceable private-record write: fresh head check, unresolved-save
   * guard, enqueue, exact confirmation and selected-head readback. With
   * `resume.id` it confirms that earlier event instead of enqueueing again.
   * `active` admits a caller's write: the outbox checks it before signing and
   * publication, including on a resumed retry. */
  async function publish(
    record: KitRecord,
    d: string,
    tag: string,
    expected: string | undefined,
    resume: Resume | undefined,
    operationSignal: AbortSignal | undefined,
    callerActive: (() => boolean) | undefined,
  ) {
    // Before enqueue, the caller can cancel preparation. After enqueue, the
    // durable outbox and session own delivery; caller cancellation cannot undo it.
    const preparing = operationSignal
      ? AbortSignal.any([signal, operationSignal])
      : signal;
    const generation = epoch;
    const active = callerActive
      ? () => generation === epoch && !preparing.aborted && callerActive()
      : undefined;
    preparing.throwIfAborted();
    if (!host || !outbox || saving)
      throw new Error("Recipe saving is unavailable or already in progress");
    saving = true;
    try {
      await ready;
      const head = async (readSignal = signal) => {
        const events = await fresh(
          [{ kinds: [30078], authors: [viewer], "#d": [d], limit: 1 }],
          readSignal,
        );
        observe(events, generation);
        return selectedHead(events);
      };
      const find = (id: string) =>
        local?.snapshot().find((e) => e.event.id === id);
      const key =
        active && resume?.intent
          ? await recoveryKey(d, resume.intent)
          : undefined;
      let id = resume?.id;
      if (!id && key) {
        id = (await outbox.recovery(key))?.event.id;
        if (id) resume?.enqueued(id);
      }
      if (id && active) {
        // A caller resumes only its own record's earlier admitted save, never
        // another record's or an unguarded one it would newly admit.
        const receipt = find(id);
        if (!receipt)
          throw new SaveSettled(
            "The original operation is unavailable. Inspect the current result before making another save.",
          );
        if (
          !key ||
          receipt.recovery?.key !== key ||
          !receipt.guarded ||
          receipt.event.kind !== 30078 ||
          !receipt.event.tags.some((t) => t[0] === "d" && t[1] === d)
        )
          throw new SaveRefused(
            "That operation is not an earlier agent save of this record with this original intent.",
          );
        const original = JSON.parse(receipt.recovery.value) as {
          expected: string | null;
        };
        const current = await head(preparing);
        if (current?.id !== id && (current?.id ?? null) !== original.expected) {
          if (receipt.delivery === "failed") await outbox.dismiss(id);
          throw new SaveSettled(
            "Another recipe save is selected. The original operation is not replayed; inspect its possible publication before saving again.",
          );
        }
      }
      if (!id) {
        preparing.throwIfAborted();
        const current = await head(preparing);
        preparing.throwIfAborted();
        if (current?.id !== expected)
          throw new Error(
            "This saved recipe changed. Refresh the catalog and review your draft before replacing it.",
          );
        for (const previous of local?.snapshot() ?? []) {
          if (
            previous.event.kind !== 30078 ||
            !previous.event.tags.some((t) => t[0] === "d" && t[1] === d)
          )
            continue;
          if (["accepted", "seen"].includes(previous.delivery)) {
            if (previous.recovery?.key.startsWith("kit-owner:"))
              await outbox.acknowledge(previous.event.id);
            continue;
          }
          if (previous.guarded && previous.delivery === "failed") {
            await outbox.dismiss(previous.event.id);
            if (!find(previous.event.id)) continue;
          }
          // A selected, newer replaceable event cannot be displaced by this
          // older receipt. Retain unknown publication evidence, never replay it.
          if (
            previous.guarded &&
            previous.delivery === "unknown" &&
            current &&
            selectedHead([current, previous.event])?.id === current.id
          )
            continue;
          throw new Error(
            "A save for this recipe is unresolved. Inspect Outbox and refresh before replacing it.",
          );
        }
        // Replaceable records use seconds. Do not create an ambiguous equal-time replacement.
        if (current && current.created_at >= Math.floor(Date.now() / 1000))
          throw new Error(
            "Please wait a second before saving this recipe again",
          );
        const content = await host.prepare(record, preparing);
        preparing.throwIfAborted();
        id = outbox.send(
          {
            kind: 30078,
            content,
            tags: [
              ["d", d],
              ["t", tag],
            ],
          },
          key
            ? { key, value: JSON.stringify({ expected: expected ?? null }) }
            : undefined,
          active,
        );
        expectations.set(id, expected ?? null);
        resume?.enqueued(id);
      }
      try {
        await confirm(id, active);
      } catch (error) {
        // A stale save, or a caller's save its gate stopped, was never
        // published; release it so it cannot block the next save here.
        const receipt = find(id);
        const reason = stale.has(id)
          ? STALE
          : active && !active() && receipt?.guarded
            ? "The call ended before it was saved; nothing was sent."
            : undefined;
        if (outbox && reason && receipt?.delivery === "failed") {
          await outbox.dismiss(id);
          if (!find(id)) {
            stale.delete(id);
            expectations.delete(id);
            throw new SaveRefused(reason);
          }
        }
        throw error;
      }
      stale.delete(id);
      expectations.delete(id);
      if ((await head())?.id !== id)
        throw new SaveSettled(
          "Another recipe save is selected. Your draft is kept; refresh and review before saving again.",
        );
      return id;
    } finally {
      saving = false;
    }
  }
  const capability = Object.freeze({
    available: !!host && !!outbox?.supports(30078),
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure() {
      if (state.status === "idle") void refresh();
    },
    refresh,
    async recovery(value: KitValue, intent: string) {
      const record: KitRecord = {
        version: 1,
        community,
        deleted: false,
        value,
      };
      return (
        await outbox?.recovery(await recoveryKey(coordinate(record), intent))
      )?.event.id;
    },
    async save(
      value: KitValue,
      expected: string | undefined,
      deleted = false,
      operationSignal?: AbortSignal,
      resume?: Resume,
      active?: () => boolean,
    ) {
      const record = parseKitRecord(
        {
          version: value.type === "team" && value.portable ? 2 : 1,
          community,
          value,
          deleted,
        },
        community,
      );
      const id = await publish(
        record,
        coordinate(record),
        kitTag(record),
        expected,
        resume,
        operationSignal,
        active,
      );
      await refresh();
      return id;
    },
  });
  const canvas = Object.freeze({
    available: !!outbox?.supports(40100),
    async read(channel: string, { strong = true }: { strong?: boolean } = {}) {
      signal.throwIfAborted();
      if (!canRead(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      return selectedHead(
        (
          await fresh([
            {
              kinds: [40100],
              "#h": [channel],
              limit: 1,
              ...(strong ? { consistency: "strong" as const } : {}),
            },
          ])
        ).filter((event) => isChannelCanvas(event, channel)),
      );
    },
    async history(
      channel: string,
      cursor?: CanvasHistoryCursor,
    ): Promise<CanvasHistoryPage> {
      signal.throwIfAborted();
      if (!canRead(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      const rows = await fresh([
        {
          kinds: [40100],
          "#h": [channel],
          limit: CANVAS_HISTORY_PAGE,
          ...(cursor ?? { consistency: "strong" as const }),
        },
      ]);
      signal.throwIfAborted();
      if (!canRead(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      if (
        rows.some(
          (event) =>
            !isChannelCanvas(event, channel) ||
            (cursor &&
              (event.created_at > cursor.until ||
                (event.created_at === cursor.until &&
                  event.id <= cursor.before_id))),
        )
      )
        throw new Error(
          "Canvas history returned an invalid or non-advancing page",
        );
      const revisions = [
        ...new Map(rows.map((event) => [event.id, event])).values(),
      ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const last = revisions.at(-1);
      return {
        revisions,
        next:
          rows.length >= CANVAS_HISTORY_PAGE && last
            ? { until: last.created_at, before_id: last.id }
            : undefined,
      };
    },
    async save(
      channel: string,
      content: string,
      expected: string | undefined,
      /** Partial editors retain approval; only a full-document save grants it. */
      options?: { preserveApproval: boolean },
    ) {
      signal.throwIfAborted();
      if (!outbox?.supports(40100) || !canWrite(channel))
        throw new Error("Canvas writing is unavailable in this channel");
      if (new TextEncoder().encode(content).length > LIVE_CANVAS_BYTES)
        throw new Error(`Keep Canvas below ${LIVE_CANVAS_LIMIT}`);
      await ready;
      signal.throwIfAborted();
      const head = await canvas.read(channel);
      if (head?.id !== expected) throw new CanvasConflictError();
      const unapproved =
        options?.preserveApproval &&
        (!head || !(await approvedCanvas(head, viewer)));
      signal.throwIfAborted();
      const pending = local
        ?.snapshot()
        .find(
          (e) =>
            e.event.kind === 40100 &&
            e.event.tags.some((t) => t[0] === "h" && t[1] === channel) &&
            !["accepted", "seen"].includes(e.delivery),
        );
      if (pending)
        throw new Error(
          "This channel has an unresolved Canvas save. Inspect Outbox before making another save.",
        );
      if (head && head.created_at >= Math.floor(Date.now() / 1000))
        throw new Error("Please wait a second before saving Canvas again");
      if (!canWrite(channel)) throw new Error("Channel access changed");
      const id = outbox.send({
        kind: 40100,
        content,
        tags: [
          ["h", channel],
          ["expected-revision", expected ?? "none"],
          ...(unapproved ? [[CANVAS_INSTRUCTIONS, "unapproved"]] : []),
        ],
      });
      await confirm(id);
      const selected = await canvas.read(channel);
      if (selected?.id !== id)
        throw new Error(
          "Your save was received, but a different Canvas is selected. Your draft is kept; load the current document.",
        );
      return selected;
    },
  });
  signal.addEventListener(
    "abort",
    () => {
      state = { status: "unavailable", entries: [] };
      listeners.forEach((l) => {
        l();
      });
      listeners.clear();
    },
    { once: true },
  );
  return {
    capability,
    canvas,
    confirm,
    /** The final synchronous check before a save of this window's record is
     * published: refuse it once this window has read a newer head than the one
     * it replaces. A local observation, not a relay compare-and-swap. */
    validatePublish(event: RelayEvent) {
      const d = event.tags.find((t) => t[0] === "d")?.[1];
      if (event.kind !== 30078 || event.pubkey !== viewer || !d) return;
      let expected = expectations.get(event.id);
      if (expected === undefined) {
        const recovery = local
          ?.snapshot()
          .find((e) => e.event.id === event.id)?.recovery;
        if (!recovery?.key.startsWith("kit-owner:")) return;
        expected = (JSON.parse(recovery.value) as { expected: string | null })
          .expected;
      }
      return () => {
        const head = observed.get(d);
        if (!head || head.id === event.id || head.id === expected) return;
        stale.add(event.id);
        throw new Error(STALE);
      };
    },
    clear() {
      epoch++;
      pending = undefined;
      state = {
        status: host && !signal.aborted ? "idle" : "unavailable",
        entries: [],
      };
      listeners.forEach((l) => {
        l();
      });
    },
  };
}
/** A save refused before anything of it was sent. */
export class SaveRefused extends Error {}
/** A save that may have been sent but can no longer be confirmed or resumed:
 * read the record again. */
export class SaveSettled extends Error {}
/** Lets a retry confirm the exact event an earlier attempt enqueued. */
export type Resume = {
  id?: string | undefined;
  /** Canonical semantic arguments, including the caller's original revision. */
  intent?: string | undefined;
  enqueued(id: string): void;
};
export type ChannelKit = ReturnType<typeof createChannelKit>["capability"];
export type ChannelCanvas = ReturnType<typeof createChannelKit>["canvas"];
/** Canvas and Todos show a channel read-only until the viewer can write it. */
export const canvasReadOnly = (channel: ChannelSummary | undefined) =>
  !channel || !!channel.archived || !!channel.readOnly || !!channel.cached;
