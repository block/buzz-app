import type { RelayReader } from "../relay/reader";
import type { RelayEvent, ReadFilter } from "../relay/events";
import type { Outbox, LocalEvents } from "../relay/outbox";
import type { ChannelKitHost } from "./host";
import { isDefinitiveCanvasConflict } from "./canvas-conflict";
import {
  CANVAS_BYTES,
  coordinate,
  KIT_TAG,
  ME_KIT_TAG,
  kitTag,
  parseKitRecord,
  type KitEntry,
  type KitRecord,
  type KitValue,
  type Team,
  type PayloadRecord,
  type TextRecord,
  parsePayloadRecord,
  parseTextRecord,
  privateCoordinate,
  TEAM_TEXT_TAG,
  textCoordinate,
} from "./model";
import {
  TEAM_MANIFEST_TAG,
  TEAM_PAYLOAD_TAG,
  encodeTeamPayload,
  encodeTeamText,
  decodeTeamPayload,
  decodeTeamText,
  payloadCoordinate,
  parseTeamManifest,
  type TeamManifest,
  type TeamPayload,
} from "./team-payload";
import type { TeamSnapshot } from "../agents/team-bundles";

const canvasConflict =
  "Canvas changed since you opened it. Your draft is kept; load the current document before replacing it.";

export type CanvasHistoryCursor = { until: number; before_id: string };
export type CanvasHistoryPage = {
  revisions: readonly RelayEvent[];
  next: CanvasHistoryCursor | undefined;
};

export const selectedHead = (events: readonly RelayEvent[]) =>
  [...events].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )[0];
type Snapshot = {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  entries: readonly KitEntry[];
  error?: string | undefined;
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
  delivered(id: string): Promise<void>;
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
  async function readRecord(record: KitRecord, readSignal = signal) {
    return selectedHead(
      await fresh(
        [
          {
            kinds: [30078],
            authors: [viewer],
            "#d": [coordinate(record)],
            limit: 1,
          },
        ],
        readSignal,
      ),
    );
  }
  async function refresh() {
    if (!host) return;
    if (pending) return pending;
    const generation = epoch;
    update({ ...state, status: "loading", error: undefined });
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
            )
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
          update({ ...state, status: "error", error: String(error) });
      } finally {
        if (generation === epoch) pending = undefined;
      }
    })();
    return pending;
  }
  async function confirm(id: string) {
    try {
      if (
        (await fresh([{ ids: [id], limit: 1, consistency: "strong" }])).some(
          (e) => e.id === id,
        )
      )
        return;
      const saved = local?.snapshot().find((e) => e.event.id === id);
      if (!saved || Date.now() / 1000 - saved.event.created_at >= 15 * 60)
        throw new Error(
          "This operation could not be confirmed and is too old to replay. Keep your draft and inspect the current result before making a new save.",
        );
      // A proven Canvas CAS refusal cannot become valid by replaying these bytes.
      if (isDefinitiveCanvasConflict(saved)) throw new Error(saved.error);
      await delivered(id);
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
        throw new Error(canvasConflict);
      }
      throw error;
    }
  }
  // Teams whose text head this session has seen; its later absence is an
  // error, never permission to fall back to legacy bundle text.
  const knownText = new Set<string>();
  async function decodeText(event: RelayEvent, readSignal: AbortSignal) {
    if (!host) throw new Error("Team instructions are unavailable");
    const rows = await host.decode([event], readSignal);
    const row = rows[0];
    if (!row || rows.length !== 1 || row.eventId !== event.id)
      throw new Error("Incomplete team instructions decode");
    const record: TextRecord = parseTextRecord(row.record, community);
    const d = privateCoordinate(record);
    if (
      record.value.owner !== viewer ||
      !event.tags.some(([tag, value]) => tag === "d" && value === d)
    )
      throw new Error("Team instructions coordinate mismatch");
    return record;
  }
  /** `undefined` only when a fresh read proves no head exists; a head this
   * session saw that is now missing is an error. */
  async function textHead(teamId: string, readSignal: AbortSignal) {
    if (!host) throw new Error("Team instructions are unavailable");
    const event = selectedHead(
      await fresh(
        [
          {
            kinds: [30078],
            authors: [viewer],
            "#d": [textCoordinate(community, viewer, teamId)],
            limit: 1,
            consistency: "strong",
          },
        ],
        readSignal,
      ),
    );
    if (!event) {
      if (knownText.has(teamId))
        throw new Error("This team's saved instructions are unavailable");
      return undefined;
    }
    // Seen counts before decoding: an invalid head that later disappears
    // stays unreadable rather than unlocking the legacy fallback.
    knownText.add(teamId);
    const record = await decodeText(event, readSignal);
    return { record, head: event.id };
  }
  /** Exact revision reads only. Never include chunks in recipe discovery. */
  async function readChunks(
    teamId: string,
    manifest: TeamManifest,
    readSignal = signal,
  ) {
    if (!host) throw new Error("Portable team payload is unavailable");
    const payloads: TeamPayload[] = [];
    for (let index = 0; index < manifest.chunks; index++) {
      readSignal.throwIfAborted();
      const d = payloadCoordinate({
        community,
        owner: viewer,
        teamId,
        revision: manifest.revision,
        index,
      });
      const event = selectedHead(
        await fresh(
          [
            {
              kinds: [30078],
              authors: [viewer],
              "#d": [d],
              limit: 2,
              consistency: "strong",
            },
          ],
          readSignal,
        ),
      );
      if (!event) throw new Error("Portable team payload is unavailable");
      const decoded = await host.decode([event], readSignal);
      const row = decoded[0];
      if (!row || decoded.length !== 1 || row.eventId !== event.id)
        throw new Error("Incomplete portable team payload decode");
      const record = parsePayloadRecord(row.record, community);
      if (
        privateCoordinate(record) !== d ||
        !event.tags.some(([tag, value]) => tag === "d" && value === d)
      )
        throw new Error("Portable team payload coordinate mismatch");
      payloads.push(record.value);
    }
    return payloads;
  }
  /** Publishes immutable chunks, reusing identical ones. Never rewrites a
   * revision with different bytes. */
  async function writeChunks(
    payloads: readonly TeamPayload[],
    preparing: AbortSignal,
  ) {
    if (!host || !outbox) throw new Error("Recipe saving is unavailable");
    await ready;
    for (const payload of payloads) {
      preparing.throwIfAborted();
      const record: PayloadRecord = {
        version: 1,
        community,
        deleted: false,
        value: {
          ...payload,
          type: "team-payload",
          id: `${payload.revision}-${payload.index}`,
        },
      };
      const d = privateCoordinate(record);
      const existing = selectedHead(
        await fresh(
          [
            {
              kinds: [30078],
              authors: [viewer],
              "#d": [d],
              limit: 1,
              consistency: "strong",
            },
          ],
          preparing,
        ),
      );
      if (existing) {
        const rows = await host.decode([existing], preparing);
        const row = rows[0];
        if (
          !row ||
          row.eventId !== existing.id ||
          JSON.stringify(parsePayloadRecord(row.record, community)) !==
            JSON.stringify(record)
        )
          throw new Error(
            "Portable team revision already has different content",
          );
        continue;
      }
      const pending = local
        ?.snapshot()
        .find(
          (item) =>
            item.event.kind === 30078 &&
            item.event.tags.some(([tag, value]) => tag === "d" && value === d),
        );
      const id =
        pending?.event.id ??
        outbox.send({
          kind: 30078,
          content: await host.prepare(record, preparing),
          tags: [
            ["d", d],
            ["t", TEAM_PAYLOAD_TAG],
          ],
        });
      await confirm(id);
    }
  }
  /** One replaceable private-record write: fresh head check, unresolved-save
   * guard, enqueue, exact confirmation and selected-head readback. With
   * `resume.id` it confirms that earlier event instead of enqueueing again. */
  async function publish(
    record: KitRecord | TextRecord,
    d: string,
    tag: string,
    expected: string | undefined,
    resume: Resume | undefined,
    operationSignal: AbortSignal | undefined,
    guard?: (preparing: AbortSignal) => Promise<void>,
  ) {
    // Before enqueue, the caller can cancel preparation. After enqueue, the
    // durable outbox and session own delivery; caller cancellation cannot undo it.
    const preparing = operationSignal
      ? AbortSignal.any([signal, operationSignal])
      : signal;
    preparing.throwIfAborted();
    if (!host || !outbox || saving)
      throw new Error("Recipe saving is unavailable or already in progress");
    saving = true;
    try {
      await ready;
      const head = async (readSignal = signal) =>
        selectedHead(
          await fresh(
            [{ kinds: [30078], authors: [viewer], "#d": [d], limit: 1 }],
            readSignal,
          ),
        );
      let id = resume?.id;
      if (!id) {
        preparing.throwIfAborted();
        await guard?.(preparing);
        const current = await head(preparing);
        preparing.throwIfAborted();
        if (current?.id !== expected)
          throw new Error(
            "This saved recipe changed. Refresh the catalog and review your draft before replacing it.",
          );
        const previous = local
          ?.snapshot()
          .find(
            (e) =>
              e.event.kind === 30078 &&
              e.event.tags.some((t) => t[0] === "d" && t[1] === d) &&
              !["accepted", "seen"].includes(e.delivery),
          );
        if (previous)
          throw new Error(
            "A save for this recipe is unresolved. Inspect Outbox and refresh before replacing it.",
          );
        // Replaceable records use seconds. Do not create an ambiguous equal-time replacement.
        if (current && current.created_at >= Math.floor(Date.now() / 1000))
          throw new Error(
            "Please wait a second before saving this recipe again",
          );
        const content = await host.prepare(record, preparing);
        preparing.throwIfAborted();
        await guard?.(preparing);
        id = outbox.send({
          kind: 30078,
          content,
          tags: [
            ["d", d],
            ["t", tag],
          ],
        });
        resume?.enqueued(id);
      }
      await confirm(id);
      if ((await head())?.id !== id)
        throw new Error(
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
    async loadTeam(team: Team): Promise<unknown> {
      if (!host || !team.portable)
        throw new Error("This team has no portable definition");
      const manifest = parseTeamManifest(team.portable);
      if (manifest.owner !== viewer)
        throw new Error("Portable team belongs to another viewer");
      return decodeTeamPayload(
        manifest,
        await readChunks(team.id, manifest),
        community,
        viewer,
        team.id,
      );
    },
    async savePortable(
      team: Omit<Team, "portable">,
      snapshot: TeamSnapshot,
      expected: string | undefined,
      revision: string,
      operationSignal?: AbortSignal,
    ) {
      const preparing = operationSignal
        ? AbortSignal.any([signal, operationSignal])
        : signal;
      preparing.throwIfAborted();
      if (
        !host ||
        !outbox ||
        !team.agents.length ||
        team.agents.length !== snapshot.members.length ||
        team.name !== snapshot.team.name
      )
        throw new Error("Portable team members do not match their definitions");
      const { manifest, payloads } = await encodeTeamPayload(
        snapshot,
        community,
        viewer,
        team.id,
        revision,
      );
      await writeChunks(payloads, preparing);
      const value: Team = { ...team, portable: manifest };
      // Confirm complete payload availability/integrity before replacing the manifest.
      await capability.loadTeam(value);
      return capability.save(value, expected, false, preparing);
    },
    /** The current team-text head: `undefined` when a fresh read proves none
     * exists, otherwise its text (empty for a tombstone). Anything unreadable
     * throws, including a head this session saw that is now missing. */
    async readText(
      teamId: string,
      readSignal = signal,
    ): Promise<{ text: string; head: string } | undefined> {
      const current = await textHead(teamId, readSignal);
      if (!current) return undefined;
      const { manifest } = current.record.value;
      return {
        text: manifest
          ? await decodeTeamText(
              manifest,
              await readChunks(teamId, manifest, readSignal),
              community,
              viewer,
              teamId,
            )
          : "",
        head: current.head,
      };
    },
    /** The current text head without its chunks, so a delete can retire a
     * head whose text is unreadable. */
    async readTextHead(teamId: string, readSignal = signal) {
      const current = await textHead(teamId, readSignal);
      return current && { head: current.head, deleted: current.record.deleted };
    },
    /** Writes and verifies the immutable chunks for one text revision. The
     * head stays untouched until `publishText`. */
    async prepareText(
      teamId: string,
      text: string,
      revision: string,
      operationSignal?: AbortSignal,
    ): Promise<TeamManifest> {
      const preparing = operationSignal
        ? AbortSignal.any([signal, operationSignal])
        : signal;
      if (!host || !outbox)
        throw new Error("Team instructions are unavailable");
      const { manifest, payloads } = await encodeTeamText(
        text,
        community,
        viewer,
        teamId,
        revision,
      );
      await writeChunks(payloads, preparing);
      if (
        (await decodeTeamText(
          manifest,
          await readChunks(teamId, manifest, preparing),
          community,
          viewer,
          teamId,
        )) !== text
      )
        throw new Error("Team instructions could not be verified");
      return manifest;
    },
    /** Moves the text head to prepared chunks, or to a tombstone when
     * `manifest` is null. A live head needs the team's expected live head. */
    async publishText(
      teamId: string,
      manifest: TeamManifest | null,
      expected: string | undefined,
      team: string | undefined,
      resume?: Resume,
      operationSignal?: AbortSignal,
    ) {
      const record = parseTextRecord(
        {
          version: 1,
          community,
          deleted: !manifest,
          value: { type: "team-text", id: teamId, owner: viewer, manifest },
        },
        community,
      );
      const d = privateCoordinate(record);
      const guard = async (preparing: AbortSignal) => {
        if (!manifest) return;
        const entry = state.entries.find((e) => e.eventId === team);
        const head = entry && (await readRecord(entry.record, preparing));
        if (
          !entry ||
          entry.record.deleted ||
          entry.record.value.type !== "team" ||
          entry.record.value.id !== teamId ||
          head?.id !== team
        )
          throw new Error(
            "This team changed or was deleted. Refresh and review it before saving its instructions.",
          );
      };
      const id = await publish(
        record,
        d,
        TEAM_TEXT_TAG,
        expected,
        resume,
        operationSignal,
        guard,
      );
      knownText.add(teamId);
      return id;
    },
    async save(
      value: KitValue,
      expected: string | undefined,
      deleted = false,
      operationSignal?: AbortSignal,
      resume?: Resume,
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
      );
      await refresh();
      return id;
    },
  });
  const canvas = Object.freeze({
    available: !!outbox?.supports(40100),
    async read(channel: string, { strong = true }: { strong?: boolean } = {}) {
      signal.throwIfAborted();
      if (!canWrite(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      return selectedHead(
        await fresh([
          {
            kinds: [40100],
            "#h": [channel],
            limit: 1,
            ...(strong ? { consistency: "strong" as const } : {}),
          },
        ]),
      );
    },
    async history(
      channel: string,
      cursor?: CanvasHistoryCursor,
    ): Promise<CanvasHistoryPage> {
      signal.throwIfAborted();
      if (!canWrite(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      const rows = await fresh([
        {
          kinds: [40100],
          "#h": [channel],
          limit: 25,
          ...(cursor ?? { consistency: "strong" as const }),
        },
      ]);
      signal.throwIfAborted();
      if (!canWrite(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      if (
        rows.some(
          (event) =>
            event.kind !== 40100 ||
            !event.tags.some((tag) => tag[0] === "h" && tag[1] === channel) ||
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
          rows.length >= 25 && last
            ? { until: last.created_at, before_id: last.id }
            : undefined,
      };
    },
    async save(channel: string, content: string, expected: string | undefined) {
      signal.throwIfAborted();
      if (!outbox?.supports(40100) || !canWrite(channel))
        throw new Error("Canvas writing is unavailable in this channel");
      if (new TextEncoder().encode(content).length > CANVAS_BYTES)
        throw new Error("Keep Canvas below 24 KiB");
      await ready;
      signal.throwIfAborted();
      const head = await canvas.read(channel);
      if (head?.id !== expected) throw new Error(canvasConflict);
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
/** Lets a retry confirm the exact event an earlier attempt enqueued. */
export type Resume = { id?: string | undefined; enqueued(id: string): void };
export type ChannelKit = ReturnType<typeof createChannelKit>["capability"];
export type ChannelCanvas = ReturnType<typeof createChannelKit>["canvas"];
