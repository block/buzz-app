import type { EventData, RelayEvent } from "../relay/events.ts";
import type { LocalEvents, Outbox, OutgoingEvent } from "../relay/outbox.ts";
import type { RelayReader } from "../relay/reader.ts";
import {
  AGENT_CATALOG_KIND,
  type AgentPublication,
  catalogD,
  catalogHeads,
  catalogTemplate,
  isShared,
  parsePublication,
  TEAM_CATALOG_KIND,
  type TeamPublication,
} from "./catalog-protocol.ts";

export type CatalogKind = typeof AGENT_CATALOG_KIND | typeof TEAM_CATALOG_KIND;
const KINDS: readonly CatalogKind[] = [AGENT_CATALOG_KIND, TEAM_CATALOG_KIND];
const PAGE = 200;
const MAX_EVENTS = 5_000;

/** queued = the relay has not answered yet; rejected = it refused or failed. */
export type CatalogDelivery = "queued" | "accepted" | "rejected";
export type CatalogShareState = Readonly<{
  /** Whether the newest relay-accepted head of this coordinate is shared. */
  shared: boolean;
  /** The newest local change of this coordinate, until it is dismissed. */
  change?: Readonly<{
    operation: string;
    shared: boolean;
    delivery: CatalogDelivery;
    error?: string;
  }>;
}>;
export type CommunityCatalogSnapshot = Readonly<{
  status: "unavailable" | "idle" | "loading" | "ready" | "error";
  error?: string;
  agents: readonly AgentPublication[];
  teams: readonly TeamPublication[];
}>;

function delivery(item: OutgoingEvent): CatalogDelivery {
  return item.delivery === "accepted" || item.delivery === "seen"
    ? "accepted"
    : item.delivery === "failed"
      ? "rejected"
      : "queued";
}
const confirmed = (item: OutgoingEvent) => delivery(item) === "accepted";
const coordinate = (event: EventData) =>
  `${event.kind}:${event.pubkey}:${catalogD(event as RelayEvent) ?? ""}`;
const isCatalog = (event: EventData) =>
  (KINDS as readonly number[]).includes(event.kind) &&
  catalogD(event as RelayEvent) !== undefined;

/** The community catalog: every shared NIP-AP head readable on this relay,
 * plus this viewer's own share changes through the durable outbox. Reading
 * never executes or adopts anything; adoption is the caller's explicit act. */
export function createCommunityCatalog({
  reader,
  viewer,
  outbox,
  local,
  notify = (listener: () => void) => listener(),
}: {
  reader: RelayReader | undefined;
  viewer: string;
  outbox: Outbox | undefined;
  local: LocalEvents | undefined;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let relayEvents: readonly RelayEvent[] = [];
  let status: CommunityCatalogSnapshot["status"] = reader
    ? "idle"
    : "unavailable";
  let error: string | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  const demands = new Set<object>();
  const listeners = new Set<() => void>();
  let ownHeads = new Map<string, EventData>();
  let changes = new Map<string, OutgoingEvent>();

  function localCatalog() {
    return (local?.snapshot() ?? []).filter(
      (item) => item.event.pubkey === viewer && isCatalog(item.event),
    );
  }
  function build(): CommunityCatalogSnapshot {
    const items = localCatalog();
    // Relay-accepted local heads count immediately; the relay read catches up.
    const accepted = items
      .filter(confirmed)
      .map((item) => (item.signed ?? item.event) as RelayEvent);
    const heads = catalogHeads([...relayEvents, ...accepted]);
    ownHeads = new Map(
      [...heads].filter(([, event]) => event.pubkey === viewer),
    );
    changes = new Map();
    for (const item of items) {
      const key = coordinate(item.event);
      const current = changes.get(key);
      if (
        !current ||
        item.event.created_at > current.event.created_at ||
        (item.event.created_at === current.event.created_at &&
          item.event.id < current.event.id)
      )
        changes.set(key, item);
    }
    const agents: AgentPublication[] = [];
    const teams: TeamPublication[] = [];
    for (const event of heads.values()) {
      const publication = parsePublication(event);
      if (publication?.kind === AGENT_CATALOG_KIND) agents.push(publication);
      else if (publication?.kind === TEAM_CATALOG_KIND) teams.push(publication);
    }
    const order = <T extends { createdAt: number; eventId: string }>(
      a: T,
      b: T,
    ) => b.createdAt - a.createdAt || (a.eventId < b.eventId ? -1 : 1);
    return Object.freeze({
      status,
      ...(error ? { error } : {}),
      agents: Object.freeze(agents.sort(order)),
      teams: Object.freeze(teams.sort(order)),
    });
  }
  let snapshot = build();
  function publish() {
    snapshot = build();
    for (const listener of listeners) notify(listener);
  }
  const stopLocal = local?.subscribe(() => {
    if (!closed) publish();
  });

  async function readAll(reader: RelayReader, signal: AbortSignal) {
    const events: RelayEvent[] = [];
    let cursor: { until: number; before_id: string } | undefined;
    for (;;) {
      signal.throwIfAborted();
      const page = await reader.read(
        [{ kinds: [...KINDS], limit: PAGE, ...cursor }],
        { signal, priority: "background" },
      );
      signal.throwIfAborted();
      // Unshared foreign heads are withheld by the relay; the head rule still
      // applies so a stale shared copy can never outrank a newer own unshare.
      events.push(...page.filter((event) => isCatalog(event)));
      if (events.length > MAX_EVENTS)
        throw new Error("Community catalog exceeds read budget");
      const last = page.at(-1);
      if (page.length < PAGE || !last) return events;
      cursor = { until: last.created_at, before_id: last.id };
    }
  }

  function refresh(): Promise<void> {
    if (closed || !reader) return Promise.resolve();
    if (pending) return pending;
    const owned = new AbortController();
    controller = owned;
    status = "loading";
    publish();
    pending = readAll(reader, owned.signal)
      .then((events) => {
        if (closed || owned.signal.aborted) return;
        relayEvents = Object.freeze(events);
        status = "ready";
        error = undefined;
        publish();
      })
      .catch(() => {
        if (closed || owned.signal.aborted) return;
        status = "error";
        error =
          "Could not read the community catalog. Check the community connection, then retry.";
        publish();
      })
      .finally(() => {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      });
    return pending;
  }

  function state(kind: CatalogKind, d: string): CatalogShareState {
    const key = `${kind}:${viewer}:${d}`;
    const head = ownHeads.get(key);
    const item = changes.get(key);
    return Object.freeze({
      shared: !!head && isShared(head as RelayEvent),
      ...(item
        ? {
            change: Object.freeze({
              operation: item.event.id,
              shared: isShared(item.event as RelayEvent),
              delivery: delivery(item),
              ...(item.error ? { error: item.error } : {}),
            }),
          }
        : {}),
    });
  }

  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      available: () => !!reader,
      writable: () => !!outbox?.supports(AGENT_CATALOG_KIND),
      refresh,
      retain() {
        const demand = {};
        demands.add(demand);
        void refresh();
        return () => {
          demands.delete(demand);
        };
      },
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      state,
      /** Publish a share or unshare head for one of the viewer's coordinates.
       * Unsharing is a newer head without the `shared` tag (NIP-AP), never a
       * deletion; adopted copies are separate, locally owned records. When
       * `content` is omitted the newest known content is reused. */
      publish(
        kind: CatalogKind,
        d: string,
        shared: boolean,
        content?: string,
      ): string {
        if (closed || !outbox?.supports(kind))
          throw new Error("This community cannot update catalog sharing.");
        const key = `${kind}:${viewer}:${d}`;
        const body =
          content ??
          changes.get(key)?.event.content ??
          ownHeads.get(key)?.content;
        if (body === undefined)
          throw new Error("Nothing has been shared from this coordinate.");
        const previous = changes.get(key);
        const id = outbox.send(catalogTemplate(kind, d, body, shared));
        // The new head is newer, so a refused older change is only clutter.
        if (previous && delivery(previous) === "rejected")
          void outbox.dismiss(previous.event.id).catch(() => {});
        return id;
      },
      retry(operation: string) {
        outbox?.retry(operation);
      },
      dismiss(operation: string) {
        return outbox?.dismiss(operation) ?? Promise.resolve();
      },
    }),
    clear() {
      controller?.abort();
      controller = undefined;
      pending = undefined;
      relayEvents = [];
      status = closed || !reader ? "unavailable" : "idle";
      error = undefined;
      publish();
    },
    reconnect() {
      if (demands.size && status !== "ready") void refresh();
    },
    dispose() {
      closed = true;
      stopLocal?.();
      demands.clear();
      controller?.abort();
      relayEvents = [];
      status = "unavailable";
      publish();
      listeners.clear();
    },
  };
}
