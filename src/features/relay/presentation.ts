import { byteSize } from "./budget";
import {
  MAX_CHECKPOINT_BYTES,
  type CheckpointStorage,
} from "./checkpoint-storage";
import type { ChannelSummary } from "./contracts";
import { DiscoveryState } from "./discovery";
import { eventDto, newer, tag, type RelayEvent } from "./events";
import { foldProfiles } from "./profiles";
import type { SidebarDecoder, SidebarPreferences } from "./sidebar-preferences";

export type Presentation = Readonly<{
  channels: readonly ChannelSummary[];
  preferences?: SidebarPreferences | undefined;
}>;
type Evidence = {
  ready?: boolean;
  complete?: boolean;
  denied?: string[];
  events: readonly RelayEvent[];
  profiles: readonly RelayEvent[];
  preferences?: SidebarPreferences | undefined;
  preferenceEvents?: readonly RelayEvent[] | undefined;
  accessEpoch: number;
};
type Checkpoint = {
  version: 1;
  viewer: string;
  community: string;
  authority: string;
  events: readonly RelayEvent[];
  profiles: readonly RelayEvent[];
  preferenceEvents: readonly RelayEvent[];
};

/** A one-way, host-owned projection of domain evidence. Never used for access,
 * event visibility, commands or delivery; no reads or sync policy of its own. */
export function createPresentation(
  viewer: string,
  community: string,
  disk: CheckpointStorage,
  decode: SidebarDecoder,
  changed: () => void,
) {
  let closed = false;
  let epoch = 0;
  let restored = false;
  let source: Evidence | undefined;
  let discardRestoredProfiles = false;
  let authority: string | undefined;
  let accessEpoch: number | undefined;
  let preferences: SidebarPreferences | undefined;
  let preferenceEvents: readonly RelayEvent[] | undefined;
  let snapshot: Presentation | undefined;
  let writes = Promise.resolve();
  let pending = false;
  let controller = new AbortController();
  const records = new Map<string, RelayEvent>();
  const profiles = new Map<string, RelayEvent>();
  const key = (event: RelayEvent) => `${event.kind}:${tag(event, "d")}`;
  const merge = (map: Map<string, RelayEvent>, id: string, event: RelayEvent) =>
    map.set(id, newer(map.get(id), event));
  function pruneProfiles() {
    // Keep persisted profile scope no broader than this sidebar needs.
    const participants = new Set(
      [...records.values()]
        .filter((event) => event.kind === 39002)
        .flatMap((event) =>
          event.tags.filter(([name]) => name === "p").map(([, id]) => id),
        ),
    );
    for (const id of profiles.keys())
      if (!participants.has(id)) profiles.delete(id);
  }
  function publish() {
    if (closed || !authority || !restored || !preferences) return;
    // This private fold is presentation only. Its membership is never exported
    // as an authority-bearing query capability.
    const discovery = new DiscoveryState(viewer, authority);
    for (const event of records.values()) discovery.accept(event);
    const names = foldProfiles([...profiles.values()]);
    const active = source?.ready
      ? new Set(
          source.events
            .filter((event) => event.kind === 39002)
            .map((event) => tag(event, "d")),
        )
      : undefined;
    const channels = discovery
      .channels()
      .filter(
        (channel) =>
          records.has(`39000:${channel.id}`) &&
          (!active || active.has(channel.id)),
      )
      .map((channel) => {
        if (channel.channelType !== "dm" || !channel.participants)
          return channel;
        const name = channel.participants.length
          ? channel.participants
              .map((id) => names.get(id)?.name ?? id.slice(0, 10))
              .join(", ")
          : "Notes to self";
        return { ...channel, name };
      });
    const next = { channels, ...(preferences ? { preferences } : {}) };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = Object.freeze(next);
    changed();
  }
  function save() {
    if (pending || closed || !restored || !authority || !preferenceEvents)
      return;
    pending = true;
    const generation = epoch;
    queueMicrotask(() => {
      pending = false;
      if (closed || generation !== epoch || !authority || !preferenceEvents)
        return;
      const value: Checkpoint = {
        version: 1,
        viewer,
        community,
        authority,
        events: [...records.values()],
        profiles: [...profiles.values()],
        preferenceEvents,
      };
      // Do not retain an obsolete checkpoint if the current projection overflows.
      writes = writes
        .then(() => {
          if (closed || generation !== epoch) return;
          return byteSize(value) <= MAX_CHECKPOINT_BYTES
            ? disk.write(value)
            : disk.clear();
        })
        .catch(() => {});
    });
  }
  async function restore() {
    const generation = epoch;
    try {
      const raw = await disk.read();
      if (
        closed ||
        generation !== epoch ||
        !raw ||
        byteSize(raw) > MAX_CHECKPOINT_BYTES
      )
        return;
      const value = raw as Checkpoint;
      if (
        value.version !== 1 ||
        value.viewer !== viewer ||
        value.community !== community ||
        !/^[0-9a-f]{64}$/.test(value.authority) ||
        !Array.isArray(value.events) ||
        value.events.length > 2048 ||
        !Array.isArray(value.profiles) ||
        value.profiles.length > 1024 ||
        !Array.isArray(value.preferenceEvents) ||
        value.preferenceEvents.length > 2
      )
        return;
      const events: RelayEvent[] = [];
      const savedProfiles: RelayEvent[] = [];
      for (const [input, output] of [
        [value.events, events],
        [value.profiles, savedProfiles],
      ] as const) {
        for (let offset = 0; offset < input.length; offset += 8) {
          output.push(
            ...input
              .slice(offset, offset + 8)
              .map((event) => eventDto(JSON.parse(JSON.stringify(event)))),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (closed || generation !== epoch) return;
        }
      }
      if (
        events.some(
          (event) =>
            event.pubkey !== value.authority ||
            ![39000, 39002].includes(event.kind),
        ) ||
        savedProfiles.some((event) => event.kind !== 0)
      )
        return;
      const groups = await decode(
        value.preferenceEvents,
        AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      );
      if (
        closed ||
        generation !== epoch ||
        (authority && authority !== value.authority)
      )
        return;
      authority = value.authority;
      for (const event of events) {
        // Fresh roster evidence owns membership, including complete omissions.
        const id = tag(event, "d");
        if (source?.denied?.includes(id ?? "")) continue;
        if (
          source?.complete &&
          !source.events.some(
            (event) => event.kind === 39002 && tag(event, "d") === id,
          )
        )
          continue;
        if (event.kind !== 39002 || !records.has(key(event)))
          merge(records, key(event), event);
      }
      if (!discardRestoredProfiles)
        for (const event of savedProfiles) merge(profiles, event.pubkey, event);
      pruneProfiles();
      if (!preferenceEvents) {
        preferences = groups;
        preferenceEvents = value.preferenceEvents;
      }
    } catch {
      /* Disposable cache: corrupt, blocked or unavailable means cold startup. */
    } finally {
      if (!closed && generation === epoch) {
        restored = true;
        publish();
        changed();
        save();
      }
    }
  }
  void restore();
  return {
    snapshot: () => snapshot,
    pending: () => !restored,
    connect(nextAuthority: string) {
      accessEpoch = undefined;
      source = undefined;
      if (authority && authority !== nextAuthority) {
        epoch++;
        controller.abort();
        restored = true;
        records.clear();
        profiles.clear();
        preferences = undefined;
        preferenceEvents = undefined;
        snapshot = undefined;
        writes = writes.then(() => disk.clear()).catch(() => {});
        changed();
      }
      authority = nextAuthority;
    },
    accept(next: Evidence) {
      if (closed) return;
      source = next;
      if (!source.ready) return;
      // A verified removal must invalidate the previous disk view even when
      // local preference decoding failed (so no coherent replacement can save).
      // Queue before notifying subscribers: disposal must not cancel this clear.
      let invalidated =
        !preferenceEvents && !!(source.complete || source.denied?.length);
      if (accessEpoch !== undefined && accessEpoch !== next.accessEpoch) {
        invalidated = true;
        profiles.clear();
        discardRestoredProfiles = true;
      }
      accessEpoch = next.accessEpoch;
      const ids = new Set(
        source.events
          .filter((event) => event.kind === 39002)
          .map((event) => tag(event, "d")),
      );
      for (const [id, event] of records)
        if (
          source.denied?.includes(tag(event, "d") ?? "") ||
          (source.complete && !ids.has(tag(event, "d")))
        ) {
          invalidated = true;
          records.delete(id);
        }
      for (const event of source.events) {
        // Current membership always replaces cached membership; only metadata
        // uses replaceable-event ordering. Neither is sent back to the session.
        if (event.kind === 39002) records.set(key(event), event);
        else merge(records, key(event), event);
      }
      for (const event of source.profiles) merge(profiles, event.pubkey, event);
      if (source.preferences && source.preferenceEvents) {
        preferences = source.preferences;
        preferenceEvents = source.preferenceEvents;
      }
      pruneProfiles();
      if (invalidated) writes = writes.then(() => disk.clear()).catch(() => {});
      save();
      publish();
    },
    async clear() {
      epoch++;
      controller.abort();
      controller = new AbortController();
      records.clear();
      profiles.clear();
      preferences = undefined;
      preferenceEvents = undefined;
      snapshot = undefined;
      source = undefined;
      restored = true;
      writes = writes.then(() => disk.clear()).catch(() => {});
      changed();
      await writes;
    },
    dispose() {
      closed = true;
      epoch++;
      controller.abort();
      void writes.finally(() => disk.close());
    },
  };
}
