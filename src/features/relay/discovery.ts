import { sessionMetadata } from "../sessions/metadata";
import { objectBody } from "./body";
import { newer, hasTag, tag, type RelayEvent } from "./events";
import type { ChannelSummary } from "./contracts";

/** NIP-29 discovery: relay-authored replaceable metadata (39000) and rosters (39002). */
export class DiscoveryState {
  private denied = new Set<string>();
  private suspended = new Set<string>();
  private complete = false;
  accessRevision = 0;
  private rosters = new Map<string, RelayEvent>();
  private metadata = new Map<string, RelayEvent>();
  constructor(
    readonly viewer: string,
    readonly relayAuthor: string,
    readonly capacity = 1024,
  ) {}
  /** Returns whether visible state changed. Events from other authors are ignored, not trusted. */
  accept(event: RelayEvent): boolean {
    if (
      event.pubkey !== this.relayAuthor ||
      (event.kind !== 39000 && event.kind !== 39002)
    )
      return false;
    const id = tag(event, "d");
    if (!id) return false;
    const map = event.kind === 39002 ? this.rosters : this.metadata;
    if (!map.has(id) && map.size >= this.capacity) return false;
    const previous = map.get(id);
    const next = newer(previous, event);
    if (next === previous) return false;
    const accessible = this.canAccess(id);
    map.set(id, next);
    if (event.kind === 39002) {
      if (
        previous &&
        hasTag(previous, "p", this.viewer) &&
        !hasTag(event, "p", this.viewer)
      )
        this.denied.add(id);
      else if (hasTag(event, "p", this.viewer)) this.denied.delete(id);
    } else if (previous && !this.rosters.has(id) && this.open(id))
      this.denied.delete(id);
    if (this.authorized(id) || (event.kind === 39000 && this.open(id)))
      this.suspended.delete(id);
    if (accessible && !this.canAccess(id)) this.accessRevision++;
    return true;
  }
  deny(id: string) {
    if (!this.canAccess(id) && !this.suspended.has(id)) return;
    // Never evict denial evidence back into "unknown". Bound adversarial IDs by
    // failing closed until fresh signed membership is available.
    if (this.denied.size >= this.capacity) {
      this.denyAll();
      return;
    }
    this.accessRevision++;
    this.suspended.delete(id);
    this.denied.add(id);
  }
  /** A CLOSED preview is unreadable pending fresh evidence, not permanently denied. */
  suspend(id: string): boolean {
    if (!this.get(id)?.readOnly) return false;
    this.suspended.add(id);
    this.accessRevision++;
    return true;
  }
  suspendedChannels(): string[] {
    return [...this.suspended];
  }
  resume(id: string): boolean {
    return this.suspended.delete(id);
  }
  /** A complete viewer-scoped roster read proves absence: rosters it omitted no longer include the viewer. */
  rosterVersions(): ReadonlyMap<string, RelayEvent> {
    return new Map(this.rosters);
  }
  retain(
    ids: ReadonlySet<string>,
    started: ReadonlyMap<string, RelayEvent>,
  ): boolean {
    let changed = !this.complete;
    this.complete = true;
    // Keep the last signed version: an old replay cannot undo authoritative loss.
    for (const [id, roster] of this.rosters)
      if (
        hasTag(roster, "p", this.viewer) &&
        !ids.has(id) &&
        !this.denied.has(id) &&
        started.get(id) === roster
      ) {
        this.denied.add(id);
        changed = true;
      }
    if (changed) this.accessRevision++;
    return changed;
  }
  denyAll() {
    this.accessRevision++;
    this.complete = true;
    for (const id of [...this.rosters.keys(), ...this.metadata.keys()])
      this.denied.add(id);
  }
  /** Unknown is not denied until a complete roster proves absence. */
  canAccess(id: string): boolean {
    if (this.denied.has(id) || this.suspended.has(id)) return false;
    const roster = this.rosters.get(id);
    if (roster && hasTag(roster, "p", this.viewer)) return true;
    return (
      this.open(id) || (!roster && !this.metadata.has(id) && !this.complete)
    );
  }
  /** Explicit signed public metadata grants reading, never membership. */
  private open(id: string): boolean {
    const event = this.metadata.get(id);
    return (
      !!event &&
      event.tags.some(([name]) => name === "public") &&
      !event.tags.some(([name]) => name === "private" || name === "hidden") &&
      !event.tags.some(([name, value]) => name === "t" && value === "dm")
    );
  }
  canParticipate(id: string): boolean {
    const roster = this.rosters.get(id);
    return (
      this.canAccess(id) &&
      (roster
        ? hasTag(roster, "p", this.viewer)
        : !this.complete && !this.open(id))
    );
  }
  authorized(id: string): boolean {
    const roster = this.rosters.get(id);
    return !this.denied.has(id) && !!roster && hasTag(roster, "p", this.viewer);
  }
  metadataVersion(id: string): RelayEvent | undefined {
    return this.metadata.get(id);
  }
  named(id: string): boolean {
    return this.metadata.has(id);
  }
  name(id: string): string {
    const event = this.metadata.get(id);
    if (!event) return id.slice(0, 8);
    let name = tag(event, "name");
    const body = objectBody(event.content);
    if (typeof body?.name === "string" && body.name) name = body.name;
    return name || id.slice(0, 8);
  }
  /** NIP-29 `hidden` marks channels (DMs) that are members-only and absent from channel directories. */
  hidden(id: string): boolean {
    const event = this.metadata.get(id);
    return !!event && event.tags.some((entry) => entry[0] === "hidden");
  }
  isPrivate(id: string): boolean {
    const event = this.metadata.get(id);
    return !!event && event.tags.some(([name]) => name === "private");
  }
  isSession(id: string): boolean {
    const event = this.metadata.get(id);
    return (
      !!event &&
      tag(event, "t") === "stream" &&
      event.tags.some(([name]) => name === "private") &&
      sessionMetadata(tag(event, "about")) !== undefined
    );
  }
  get(id: string): ChannelSummary | undefined {
    if (!this.canAccess(id) || (!this.authorized(id) && !this.open(id))) return;
    const event = this.metadata.get(id);
    const type = this.isSession(id) ? "session" : event && tag(event, "t");
    const channelType =
      type === "stream" ||
      type === "forum" ||
      type === "dm" ||
      (type === "session" && this.isSession(id))
        ? type
        : undefined;
    const roster = this.rosters.get(id);
    const parentId = event && sessionMetadata(tag(event, "about"))?.parentId;
    return {
      id,
      ...(!this.authorized(id) ? { readOnly: true as const } : {}),
      name: this.name(id),
      members: Object.freeze(
        [
          ...new Set(
            roster?.tags.flatMap(([name, value]) =>
              name === "p" && value && /^[0-9a-f]{64}$/.test(value)
                ? [value]
                : [],
            ),
          ),
        ].sort(),
      ),
      ...(this.hidden(id) ? { hidden: true } : {}),
      ...(this.isPrivate(id) ? { private: true } : {}),
      ...(channelType ? { channelType } : {}),
      ...(channelType === "session" && event
        ? {
            updatedAt: event.created_at,
            ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              parentId ?? "",
            )
              ? { parentChannelId: parentId }
              : {}),
          }
        : {}),
      ...(event && hasTag(event, "archived", "true") ? { archived: true } : {}),
      ...(channelType === "dm"
        ? {
            participants: [
              ...new Set(
                roster?.tags.flatMap(([name, value]) =>
                  name === "p" &&
                  typeof value === "string" &&
                  value !== this.viewer &&
                  /^[0-9a-f]{64}$/.test(value)
                    ? [value]
                    : [],
                ),
              ),
            ].sort(),
          }
        : {}),
    };
  }
  channels(): ChannelSummary[] {
    return [...this.rosters.keys()]
      .filter((id) => this.authorized(id))
      .flatMap((id) => {
        const channel = this.get(id);
        return channel ? [channel] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
}
