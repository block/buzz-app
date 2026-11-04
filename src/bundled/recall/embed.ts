import { pubkeyOf } from "../../features/agents/membership";
import {
  boundedInput,
  createEmbeddingClient,
  type EmbeddingHost,
  EmbeddingHttpError,
} from "./embed-client.ts";
import { channelOf, live, mayFlow, ownerOnly } from "./find.ts";
import type { Candidate, MemoryListing, Settings, Turn } from "./types.ts";
export type { EmbeddingHost } from "./embed-client.ts";
export type Embeddings = ReturnType<typeof createEmbeddings>;
const CAPACITY = 20_000;
const encoder = new TextEncoder();
type Unit = {
  id: string;
  kind: "message" | "memory";
  version: number;
  text: string;
};
type Row = Omit<Unit, "text"> & { vector: Float32Array };
type Bank = Map<string, Row>;
type Snapshot = {
  key: string;
  units: Unit[];
  generation: number;
  sequence: number;
  completeMemory?: boolean;
};
const stamp = (u: Pick<Unit, "id" | "version">) =>
  JSON.stringify([u.id, u.version]);

export function createEmbeddings(
  host: EmbeddingHost,
  settings: () => Settings,
  now = Date.now,
) {
  const banks = new Map<string, Bank>();
  const pending = new Map<string, Snapshot>();
  const latest = new Map<string, number>();
  let generation = 0;
  let sequence = 0;
  let active = true;
  let worker: Promise<void> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const client = createEmbeddingClient(host, settings, clear);
  const ready = () => active && client.configured();
  function clear() {
    generation++;
    banks.clear();
    pending.clear();
    latest.clear();
    if (scheduled !== undefined) clearTimeout(scheduled);
    scheduled = undefined;
  }
  const key = (turn: Turn, scope: string) =>
    JSON.stringify([
      turn.community,
      turn.owner,
      turn.agent,
      scope,
      client.identity(),
    ]);
  function touch(k: string, bank: Bank) {
    banks.delete(k);
    banks.set(k, bank);
  }
  function trim() {
    let count = [...banks.values()].reduce((sum, b) => sum + b.size, 0);
    while (count > CAPACITY) {
      // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
      const oldest = banks.keys().next().value!;
      // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
      count -= banks.get(oldest)!.size;
      banks.delete(oldest);
    }
  }

  function queue(s: Snapshot) {
    if (s.sequence < (latest.get(s.key) ?? -1)) return;
    latest.set(s.key, s.sequence);
    pending.delete(s.key);
    pending.set(s.key, s);
    let queued = [...pending.values()].reduce(
      (sum, p) => sum + p.units.length,
      0,
    );
    while (queued > CAPACITY) {
      // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
      const oldest = pending.keys().next().value!;
      // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
      queued -= pending.get(oldest)!.units.length;
      pending.delete(oldest);
    }
    // A macrotask starts only after the synchronous run continuation can release its lease.
    if (!worker && scheduled === undefined)
      scheduled = setTimeout(() => {
        scheduled = undefined;
        worker = drain().finally(() => {
          worker = undefined;
          // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
          if (pending.size) queue(pending.values().next().value!);
        });
      }, 0);
  }
  async function drain() {
    while (pending.size && ready()) {
      // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
      const s = pending.values().next().value!;
      pending.delete(s.key);
      try {
        const bank = banks.get(s.key) ?? new Map<string, Row>();
        if (s.generation !== generation || s.sequence !== latest.get(s.key))
          continue;
        if (s.completeMemory !== undefined) {
          const versions = new Map(s.units.map((u) => [u.id, u.version]));
          for (const [id, row] of bank) {
            const version = versions.get(row.id);
            if (
              (version !== undefined && row.version < version) ||
              (s.completeMemory && version === undefined)
            )
              bank.delete(id);
          }
        }
        const fresh = s.units.filter((u) => !bank.has(stamp(u)));
        for (let i = 0; i < fresh.length; i += 16) {
          const batch = fresh.slice(i, i + 16);
          const vectors = await client
            .embed(batch.map((u) => (settings().documentPrefix ?? "") + u.text))
            .catch((error: unknown) => {
              if (!(error instanceof EmbeddingHttpError)) throw error;
              return undefined;
            });
          if (
            !ready() ||
            s.generation !== generation ||
            s.sequence !== latest.get(s.key)
          )
            break;
          if (!vectors) continue;
          batch.forEach(({ text: _, ...u }, j) => {
            // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
            bank.set(stamp(u), { ...u, vector: vectors[j]! });
          });
          touch(s.key, bank);
          trim();
        }
      } catch {
        /* a failed optional index job never affects the turn */
      }
    }
  }

  async function observe(turn: Turn): Promise<() => void> {
    if (!ready()) return () => {};
    const g = generation;
    const serial = ++sequence;
    try {
      const facts = turn.reads.channel(turn.channel);
      const [events, listing] = await Promise.all([
        turn.reads.events({ kinds: [9], "#h": [turn.channel], limit: 500 }),
        facts.then((channel) =>
          settings().sharedMemories ||
          ownerOnly(channel, turn.owner, pubkeyOf(turn.agent))
            ? turn.reads.memories()
            : undefined,
        ),
      ]);
      if (!ready() || g !== generation) return () => {};
      const units = events
        .filter(
          (e) =>
            e.kind === 9 &&
            channelOf(e) === turn.channel &&
            e.id !== turn.event,
        )
        .slice(0, 500)
        .map(
          (e): Unit => ({
            id: e.id,
            kind: "message",
            version: e.created_at,
            text: boundedInput(e.content),
          }),
        );
      const snapshots: Snapshot[] = [
        {
          key: key(turn, turn.channel),
          units,
          generation: g,
          sequence: serial,
        },
      ];
      if (listing)
        snapshots.push({
          key: key(turn, "memory"),
          units: memoryUnits(listing),
          generation: g,
          sequence: serial,
          completeMemory: !listing.partial,
        });
      return () => {
        if (ready() && g === generation) snapshots.forEach(queue);
      };
    } catch {
      return () => {};
    }
  }
  async function neighbours(turn: Turn): Promise<Candidate[]> {
    if (!ready() || now() >= turn.deadline) return [];
    const g = generation;
    try {
      const target = await turn.reads.channel(turn.channel);
      const allowMem =
        settings().sharedMemories ||
        ownerOnly(target, turn.owner, pubkeyOf(turn.agent));
      const memoryKey = key(turn, "memory");
      const mine = (k: string) => {
        const [c, o, a, scope] = JSON.parse(k) as string[];
        return (
          c === turn.community &&
          o === turn.owner &&
          a === turn.agent &&
          scope !== "memory"
        );
      };
      const channels =
        settings().scope === "relay"
          ? [...banks.keys()].filter(mine)
          : [key(turn, turn.channel)];
      const relevant = [...channels, ...(allowMem ? [memoryKey] : [])];
      const rows = relevant.flatMap((k) => {
        const bank = banks.get(k);
        if (!bank) return [];
        touch(k, bank);
        return [...bank.values()];
      });
      if (!rows.length) return [];
      const [query] = await client.embed(
        [(settings().queryPrefix ?? "") + turn.text],
        Math.max(1, Math.min(1000, turn.deadline - now())),
      );
      const ranked = rows
        .map((row) => ({
          row,
          // biome-ignore lint/style/noNonNullAssertion: The paired collection is populated and validated before indexed access.
          score: row.vector.reduce((sum, n, i) => sum + n * query![i]!, 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map(({ row }) => row);
      const ids = ranked.filter((r) => r.kind === "message").map((r) => r.id);
      const [events, listing] = await Promise.all([
        ids.length ? turn.reads.events({ ids, kinds: [9], limit: 40 }) : [],
        allowMem && ranked.some((r) => r.kind === "memory")
          ? turn.reads.memories()
          : undefined,
      ]);
      const currentMem = new Map(
        (listing ? memoryUnits(listing) : []).map((u) => [stamp(u), u]),
      );
      const sources = new Map(
        await Promise.all(
          [...new Set(events.map(channelOf))]
            .filter((s): s is string => !!s)
            .map(
              async (s) =>
                [
                  s,
                  s === turn.channel ? target : await turn.reads.channel(s),
                ] as const,
            ),
        ),
      );
      if (!ready() || g !== generation || now() >= turn.deadline) return [];
      return ranked.flatMap((r): Candidate[] => {
        if (r.kind === "memory") {
          const m = currentMem.get(stamp(r));
          return m
            ? [{ id: m.id, kind: "memory", text: m.text, at: m.version }]
            : [];
        }
        const e = events.find((e) => e.id === r.id && e.kind === 9);
        const s = e && channelOf(e);
        if (
          !e ||
          !s ||
          e.id === turn.event ||
          !mayFlow(s, turn.channel, sources.get(s), target)
        )
          return [];
        return [
          {
            id: e.id,
            kind: "message",
            text: e.content,
            at: e.created_at,
            author: e.pubkey,
            channel: s,
          },
        ];
      });
    } catch {
      return [];
    }
  }

  return {
    neighbours,
    observe,
    enable: async () => {
      active = true;
      client.configured();
    },
    disable: async () => {
      active = false;
      clear();
    },
    refresh: () => {
      client.configured();
    },
    test: async () => {
      const start = now();
      await client.embed(["Recall connection test"]);
      return { ...client.status(), ms: Math.max(0, now() - start) };
    },
    idle: async () => {
      if (scheduled !== undefined) await new Promise((r) => setTimeout(r, 0));
      await worker;
    },
    queuedBytes: () =>
      [...pending.values()].reduce(
        (sum, s) =>
          sum + s.units.reduce((n, u) => n + encoder.encode(u.text).length, 0),
        0,
      ),
    size: () => [...banks.values()].reduce((sum, b) => sum + b.size, 0),
  };
}

function memoryUnits(listing: MemoryListing): Unit[] {
  return live(listing)
    .flatMap((m) =>
      m.body
        .split("\n")
        .map(
          (text, i): Unit => ({
            id: `${m.slug}#${i}`,
            kind: "memory",
            version: m.createdAt,
            text: boundedInput(text.trim()),
          }),
        )
        .filter((m) => m.text),
    )
    .slice(0, CAPACITY);
}
