// TEMPORARY: remove this module and its startup call (service.ts) after
// 2026-11-30, once the development users have upgraded. Event watches had a
// `keywords` selector until it was removed; the relay attention spec never had
// one. Startup turns each such watch off and gives its Interest a one-shot
// timer that tells the agent why, so the agent can rework the watch.
import { MIN_INTERVAL_SECS } from "./attention-objects";
import { OBJECT_LIMIT, validateObject, watchSlug } from "./attention";
import type { AgentStore } from "./state";
import { RECORD_PREFIX, STORAGE_KEY } from "./store";

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const notice = (id: string, name: unknown, keywords: unknown) =>
  `Buzz no longer supports the keywords selector on event watches. Your watch ${JSON.stringify(id)}${typeof name === "string" ? ` (${name})` : ""} matched only events whose content contained any of ${JSON.stringify(keywords)}. Buzz removed the keywords and turned the watch off. If you turn it on as it is, it wakes you for every event its channels and kinds match. Show the watch, then either narrow it with a classifier question or with authors, exclude_authors, tags or is_reply, and enable it; or remove it if the Interest no longer needs it.`;

/** A free timer slug for the watch `id`. */
function timerSlug(attention: Record<string, unknown>, id: string) {
  const preferred = `fix-${id}`;
  if (preferred.length <= 64 && !(watchSlug(preferred) in attention))
    return watchSlug(preferred);
  for (let n = 1; ; n++)
    if (!(watchSlug(`fix-keywords-${n}`) in attention))
      return watchSlug(`fix-keywords-${n}`);
}

/** Converts the record's keyword watches in place; true when any changed. A
 * watch stays as it is (skipped, for the owner to repair) when its timer does
 * not fit the record's object limit. */
function upgradeRecord(record: unknown, now: number) {
  const attention = isObject(record) ? record.attention : undefined;
  if (!isObject(record) || !isObject(attention)) return false;
  let changed = false;
  for (const [slug, object] of Object.entries(attention)) {
    const value = isObject(object) ? object.value : undefined;
    if (
      !isObject(object) ||
      !isObject(value) ||
      value.type !== "event" ||
      !("keywords" in value)
    )
      continue;
    const { keywords, ...rest } = value;
    const watch: Record<string, unknown> = { ...rest, enabled: false };
    const id = slug.slice("watch/".length);
    const fix = timerSlug(attention, id);
    const timer = {
      type: "timer",
      interest_id: watch.interest_id,
      prompt: notice(id, watch.name, keywords),
      enabled: true,
      interval_secs: MIN_INTERVAL_SECS,
      armed_at: now,
      max_occurrences: 1,
      expires_at: null,
      ...(typeof watch.channel === "string" ? { channel: watch.channel } : {}),
      ...(typeof watch.root === "string" ? { root: watch.root } : {}),
    };
    const watches = Object.values(attention).filter(
      (other) =>
        isObject(other) &&
        isObject(other.value) &&
        other.value.type !== "interest",
    ).length;
    const problem =
      validateObject(slug, watch) ??
      validateObject(fix, timer) ??
      (watches >= OBJECT_LIMIT
        ? `the notice timer would pass the limit of ${OBJECT_LIMIT} watches and timers`
        : undefined);
    if (problem) {
      console.error(`Cannot remove the keywords of ${slug}: ${problem}`);
      continue;
    }
    attention[slug] = { ...object, value: watch, modifiedAt: now };
    attention[fix] = { slug: fix, value: timer, modifiedAt: now };
    // Saved state, so a timer first seen after its interval still runs once.
    record.timers = {
      ...(isObject(record.timers) ? record.timers : {}),
      [fix]: { armedAt: now, nextDue: now + MIN_INTERVAL_SECS, used: 0 },
    };
    changed = true;
  }
  return changed;
}

const save = (storage: AgentStore, key: string, value: unknown) =>
  storage.set(key, JSON.stringify(value)).catch((error: unknown) => {
    console.error("Cannot save the converted keyword watches", error);
  });

/** Converts every stored keyword watch in place, in the legacy shared record
 * and in each agent's own record. A failure must not stop startup, so each
 * failed save is only logged. */
export async function migrateWatchKeywords(
  storage: AgentStore,
  now = Math.floor(Date.now() / 1000),
) {
  const saves: Promise<void>[] = [];
  const legacy = parsed(storage.get(STORAGE_KEY));
  const agents = isObject(legacy) ? legacy.agents : undefined;
  if (isObject(agents)) {
    let changed = false;
    for (const record of Object.values(agents))
      if (upgradeRecord(record, now)) changed = true;
    if (changed) saves.push(save(storage, STORAGE_KEY, legacy));
  }
  for (const key of storage.keys()) {
    if (!key.startsWith(RECORD_PREFIX)) continue;
    const record = parsed(storage.get(key));
    if (upgradeRecord(record, now)) saves.push(save(storage, key, record));
  }
  await Promise.all(saves);
}

function parsed(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return undefined;
  }
}
