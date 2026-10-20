// Archive and recover for config channels (plan §8.1): a durable intent,
// retried on reconnect and restart until strong relay metadata confirms it.
// It rolls back only after a definite refusal plus a strong read showing the
// old state; anything uncertain keeps it pending and starts blocked.
import { PublishRejected } from "../relay/outbox";
import { refusal } from "./agent-config-artifacts";
import type { ConfigChannels } from "./config-channels";
import type { JournalStore } from "./config-writes";
import { SavedState } from "./saved-state";
import { localStore } from "./store";

export const LIFECYCLE_STORAGE_KEY = "buzz.agents.config.lifecycle.v1";

export type Lifecycle = "active" | "archiving" | "archived" | "recovering";
type Entry = Readonly<{ state: Exclude<Lifecycle, "active">; channel: string }>;

type Entries = Readonly<Record<string, Entry>>;

/** Per `community\nsubject` (agent pubkey or team id); absent is `active`.
 * Each change is seen once it is saved, and a failed one changes nothing
 * (`SavedState`). */
export class LifecycleJournal {
  private readonly state: SavedState<Entries>;
  constructor(storage: JournalStore = localStore()) {
    let saved: Entries = {};
    try {
      const value = JSON.parse(
        storage.get(LIFECYCLE_STORAGE_KEY) ?? "null",
      ) as { version?: unknown; entries?: unknown } | null;
      if (
        value?.version === 1 &&
        value.entries &&
        typeof value.entries === "object"
      )
        saved = value.entries as Entries;
    } catch {
      /* Start fresh after malformed local data. */
    }
    this.state = new SavedState(saved, (entries) =>
      storage.set(
        LIFECYCLE_STORAGE_KEY,
        JSON.stringify({ version: 1, entries }),
      ),
    );
  }
  get = (community: string, subject: string): Lifecycle =>
    this.state.current[`${community}\n${subject}`]?.state ?? "active";
  pending = (community: string) =>
    Object.entries(this.state.current).flatMap(([key, entry]) => {
      const [at, subject] = key.split("\n");
      return at === community &&
        subject &&
        (entry.state === "archiving" || entry.state === "recovering")
        ? [{ subject, ...entry }]
        : [];
    });
  /** Saves the subject's entry as `next` makes it from the saved one, once
   * earlier changes settled; resolves once saved. */
  change(
    community: string,
    subject: string,
    next: (entry: Entry | undefined) => Entry | undefined,
  ) {
    const key = `${community}\n${subject}`;
    return this.state.change((entries) => {
      const before = entries[key];
      const after = next(before);
      if (after === before) return entries;
      const { [key]: _, ...rest } = entries;
      return after ? { ...rest, [key]: after } : rest;
    });
  }
  /** Saves `entry` as the subject's, once earlier changes settled. */
  put(community: string, subject: string, entry: Entry | undefined) {
    return this.change(community, subject, () => entry);
  }
}

/** A relay answer that refuses the request outright, as opposed to one
 * that may still have taken effect (timeout, lost OK, rate limit). */
function definite(error: unknown) {
  if (!(error instanceof PublishRejected)) return false;
  const kind = refusal(error.reason ?? error.message);
  return kind !== "unknown" && kind !== "rate-limited" && kind !== "duplicate";
}

export type LifecycleDeps = Readonly<{
  channels: Pick<ConfigChannels, "archive" | "unarchive" | "archived">;
  journal: LifecycleJournal;
  community: string;
  signal?: AbortSignal;
}>;

/** Persists the intent, then drives it once. Call `drive` again to retry.
 * Nothing is requested unless the intent was saved. */
export async function begin(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
  action: "archive" | "recover",
) {
  await deps.journal.put(deps.community, subject, {
    state: action === "archive" ? "archiving" : "recovering",
    channel,
  });
  return drive(deps, subject, channel);
}

/** One request and strong metadata read for a pending intent. */
export async function drive(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
): Promise<Lifecycle> {
  const { journal, community, channels, signal } = deps;
  const state = journal.get(community, subject);
  if (state !== "archiving" && state !== "recovering") return state;
  const archiving = state === "archiving";
  let refused = false;
  try {
    await (archiving
      ? channels.archive(channel, signal)
      : channels.unarchive(channel, signal));
  } catch (error) {
    refused = definite(error);
  }
  let archived: boolean;
  try {
    archived = await channels.archived(channel, signal);
  } catch {
    return state;
  }
  return settle(deps, subject, channel, archived, refused);
}

/** Applies strong (or live-discovered) metadata to a pending intent, if it
 * is still the one saved when its turn to save comes: a newer intent stays. */
export async function settle(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
  archived: boolean,
  refused = false,
): Promise<Lifecycle> {
  const { journal, community } = deps;
  const state = journal.get(community, subject);
  await journal.change(community, subject, (entry) => {
    if (entry?.state !== state || entry.channel !== channel) return entry;
    if (state === "archiving") {
      if (archived) return { state: "archived", channel };
      return refused ? undefined : entry;
    }
    if (state === "recovering") {
      if (!archived) return undefined;
      return refused ? { state: "archived", channel } : entry;
    }
    return entry;
  });
  return journal.get(community, subject);
}

/** Applies discovered metadata, whoever changed it: a pending intent settles,
 * and with none pending the channel's own state is admitted, so an archive or
 * recovery made on another device holds here too. */
export async function observe(
  deps: LifecycleDeps,
  subject: string,
  channel: string,
  archived: boolean,
): Promise<Lifecycle> {
  const { journal, community } = deps;
  const state = journal.get(community, subject);
  if (state === "archiving" || state === "recovering")
    return settle(deps, subject, channel, archived);
  await journal.change(community, subject, (entry) => {
    // An intent begun meanwhile is newer than this observation.
    if (entry?.state === "archiving" || entry?.state === "recovering")
      return entry;
    if (!archived) return undefined;
    return entry?.state === "archived" && entry.channel === channel
      ? entry
      : { state: "archived", channel };
  });
  return journal.get(community, subject);
}

/** Retries every pending intent in the community: on reconnect and restart. */
export const resumeAll = (deps: LifecycleDeps) =>
  Promise.all(
    deps.journal
      .pending(deps.community)
      .map(({ subject, channel }) => drive(deps, subject, channel)),
  );
