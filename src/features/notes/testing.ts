// Test-only relay stand-in. Real sessions, outboxes, event signatures and owner
// attestations; an in-memory server models membership and atomic artifact heads.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import type { BuzzClient, Filter } from "../../buzz-mcp/client";
import { eventDto, type ReadFilter, type RelayEvent } from "../relay/events";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import { bounds, keypair, signed, type Key } from "../relay/testing";
import type { RelayWriter } from "../relay/transport";
import {
  AGENTS_LABEL,
  NOTE_LABEL,
  noteTag,
  noteTemplate,
  parseNote,
  type Note,
  type NoteDraft,
} from "./model";

export async function notesFixture() {
  const viewer = keypair(),
    relay = keypair(),
    carl = keypair(),
    ned = keypair(),
    sam = keypair();
  const origin = "https://notes.example.test";
  let tick = 1_790_000_000;
  let failArtifact = false,
    loseArtifactReceipt = false,
    inventoryUnavailable = false;
  const profiles: RelayEvent[] = [];
  for (const [key, name] of [
    [carl, "Carl"],
    [ned, "Ned"],
  ] as const) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`nostr:agent-auth:${key.pubkey}:`),
    );
    const auth = [
      "auth",
      viewer.pubkey,
      "",
      bytesToHex(schnorr.sign(new Uint8Array(digest), viewer.secret)),
    ];
    profiles.push(
      eventDto(
        signed(key, {
          kind: 0,
          content: JSON.stringify({ name, bot: true }),
          tags: [auth],
        }),
      ),
    );
  }
  for (const [key, name] of [
    [viewer, "Taylor"],
    [sam, "Sam"],
  ] as const)
    profiles.push(
      eventDto(
        signed(key, { kind: 0, content: JSON.stringify({ name }), tags: [] }),
      ),
    );
  const channels = new Map<
    string,
    {
      id: string;
      name: string;
      creator: string;
      labels: string[];
      type: string;
      roles: Record<string, string>;
      visibility?: "public" | "private";
      joinRole?: "guest" | "member";
      updated: number;
      created: number;
    }
  >();
  const heads = new Map<string, RelayEvent>();
  const revisions: RelayEvent[] = [],
    accepted: RelayEvent[] = [],
    queries: ReadFilter[][] = [];
  let agentKeys = [carl.pubkey, ned.pubkey];
  const channelSnapshots = new Map<
    string,
    { state: string; events: ReturnType<typeof eventDto>[] }
  >();
  const channelEvents = () =>
    [...channels.values()].flatMap((channel) => {
      // A relay serves persisted signed snapshots, not newly signed copies on
      // every read. Include all fields: tests also mutate roles directly.
      const state = JSON.stringify(channel);
      const cached = channelSnapshots.get(channel.id);
      if (cached?.state === state) return cached.events;
      const tags = [
        ["d", channel.id],
        ["t", channel.type],
        ...channel.labels.map((label) => ["t", label]),
      ];
      const events = [
        signed(relay, {
          kind: 39000,
          created_at: channel.updated,
          content: "",
          tags: [
            ...tags,
            ["P", channel.creator],
            ["created_at", String(channel.created)],
            ["name", channel.name],
            [channel.visibility ?? "private"],
            ["join_role", channel.joinRole ?? "member"],
            ...(channel.type === "system" ? [["hidden"]] : []),
          ],
        }),
        signed(relay, {
          kind: 39001,
          created_at: channel.updated,
          content: "",
          tags: [
            ...tags,
            ...Object.entries(channel.roles)
              .filter(([, role]) => role === "owner" || role === "admin")
              .map(([key, role]) => ["p", key, role]),
          ],
        }),
        signed(relay, {
          kind: 39002,
          created_at: channel.updated,
          content: "",
          tags: [
            ...tags,
            ...Object.entries(channel.roles).map(([key, role]) => [
              "p",
              key,
              "",
              role,
            ]),
          ],
        }),
      ].map(eventDto);
      channelSnapshots.set(channel.id, { state, events });
      return events;
    });
  const queryAs = async (who: string, filters: readonly ReadFilter[]) => {
    queries.push(filters.map((filter) => ({ ...filter })));
    return filters.flatMap((filter) => {
      let pool =
        filter.artifact === "history"
          ? [...revisions].reverse()
          : [
              ...profiles,
              ...channelEvents(),
              ...heads.values(),
              ...accepted.filter((event) => event.kind !== 45010),
            ];
      pool = pool.filter((event) => {
        const channel = channels.get(
          noteTag(
            event,
            event.kind >= 39000 && event.kind <= 39003 ? "d" : "h",
          ) ?? "",
        );
        if (channel && !channel.roles[who] && channel.visibility !== "public")
          return false;
        if (
          channel?.type === "system" &&
          !(filter["#h"] || filter["#d"] || filter["#t"])
        )
          return false;
        if (filter.artifact === "current" && noteTag(event, "op") === "delete")
          return false;
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        if (filter.ids && !filter.ids.includes(event.id)) return false;
        if (filter.authors && !filter.authors.includes(event.pubkey))
          return false;
        for (const [key, values] of Object.entries(filter))
          if (
            key.startsWith("#") &&
            Array.isArray(values) &&
            !event.tags.some(
              ([name, value]) =>
                name === key.slice(1) && values.includes(value),
            )
          )
            return false;
        if (
          filter.until !== undefined &&
          (event.created_at > filter.until ||
            (event.created_at === filter.until &&
              filter.before_id &&
              event.id <= filter.before_id))
        )
          return false;
        return true;
      });
      if (filter.artifact !== "history")
        pool.sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      const page = pool.slice(
        filter.offset ?? 0,
        (filter.offset ?? 0) + filter.limit,
      );
      const channelId = filter["#h"]?.[0];
      if (channelId && filter.kinds?.includes(9))
        page.push(
          bounds(relay, channelId, "head", {
            has_more: false,
            next_cursor: null,
          }),
        );
      return page;
    });
  };
  const publishAs = async (who: string, event: RelayEvent) => {
    const id = noteTag(event, "h") ?? "";
    const channel = channels.get(id);
    const role = channel?.roles[who];
    if (event.kind === 9007) {
      if (channel) throw new PublishRejected("duplicate: channel exists");
      channels.set(id, {
        id,
        name: noteTag(event, "name") ?? "Page",
        creator: who,
        type: noteTag(event, "channel_type") ?? "stream",
        labels: event.tags
          .filter(([key]) => key === "t")
          .map(([, value]) => value ?? ""),
        roles: { [who]: "owner" },
        updated: ++tick,
        created: tick,
      });
    } else if (
      event.kind === 9000 ||
      event.kind === 9001 ||
      event.kind === 9002
    ) {
      if (!channel || (role !== "owner" && role !== "admin"))
        throw new PublishRejected("restricted: administration denied");
      const key = noteTag(event, "p") ?? "";
      if (event.kind === 9000) {
        const requested = noteTag(event, "role") ?? "member";
        channel.roles[key] =
          requested === "member" && agentKeys.includes(key) ? "bot" : requested;
      }
      if (event.kind === 9001) delete channel.roles[key];
      if (event.kind === 9002) {
        if (event.tags.some(([key]) => key === "t"))
          channel.labels = event.tags
            .filter(([key]) => key === "t")
            .map(([, value]) => value ?? "")
            .filter(Boolean);
        channel.name = noteTag(event, "name") ?? channel.name;
        const visibility = noteTag(event, "visibility");
        if (visibility)
          channel.visibility = visibility === "open" ? "public" : "private";
        const joinRole = noteTag(event, "join_role");
        if (joinRole === "guest" || joinRole === "member")
          channel.joinRole = joinRole;
      }
      channel.updated = ++tick;
    } else if (event.kind === 45010) {
      if (failArtifact) {
        failArtifact = false;
        throw new PublishRejected("invalid: fixture refused this save");
      }
      if (
        role === "guest" ||
        (!role &&
          !(channel?.visibility === "public" && channel.joinRole !== "guest"))
      )
        throw new PublishRejected("restricted: write denied");
      const d = noteTag(event, "d") ?? "",
        prior = heads.get(d);
      if (prior?.id === event.id) return "duplicate: accepted";
      if (
        (prior && noteTag(event, "prev") !== prior.id) ||
        (!prior && noteTag(event, "op") !== "create")
      )
        throw new PublishRejected("conflict: stale revision");
      // NIP-AR roots are conversation anchors, not artifact revision IDs.
      const root = noteTag(event, "root"),
        oldRoot = prior ? noteTag(prior, "root") : undefined;
      if (noteTag(event, "op") === "delete" && root !== oldRoot)
        throw new PublishRejected("invalid: delete preserves root");
      if (root && (!prior || root !== oldRoot)) {
        const anchor = accepted.find((item) => item.id === root);
        if (
          !anchor ||
          noteTag(anchor, "h") !== id ||
          ![9, 40002, 45001, 45003].includes(anchor.kind)
        )
          throw new PublishRejected(
            "invalid: root must be an existing conversation anchor in home",
          );
      }
      heads.set(d, event);
      revisions.push(event);
      if (loseArtifactReceipt) {
        loseArtifactReceipt = false;
        throw new Error("Connection lost after acceptance");
      }
    }
    accepted.push(event);
    return "saved";
  };
  const signer = (key: Key): RelayWriter => ({
    kinds: [9, 9007, 9000, 9001, 9002, 45010],
    sign: async (template) => eventDto(signed(key, template)),
    publish: (event) => publishAs(key.pubkey, event),
  });
  const writer = signer(viewer);
  const owner = createRelaySession(
    {
      scope: origin,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      channelIdentity: true,
      media: () => undefined,
      query: (filters) => queryAs(viewer.pubkey, filters),
      writer,
      configArtifacts: writer,
      memberAdministration: writer,
      channelDetails: writer,
      readAgentLibrary: async () => {
        if (inventoryUnavailable) throw new Error("Inventory unavailable");
        return {
          definitions: [],
          identities: agentKeys.map((pubkey) => ({
            pubkey,
            name: pubkey === carl.pubkey ? "Carl" : "Ned",
          })),
        };
      },
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  const client = (key = carl): BuzzClient => ({
    pubkey: key.pubkey,
    key: key.pubkey,
    owner: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query: (filters: readonly Filter[]) =>
      queryAs(key.pubkey, filters as readonly ReadFilter[]),
    publish: async (template) => {
      const event = eventDto(
        signed(key, {
          ...template,
          tags: template.tags.map((tag) => [...tag]),
          created_at: ++tick,
        }),
      );
      await publishAs(key.pubkey, event);
      return event;
    },
    read: async () => new TextEncoder().encode("# File contents"),
    upload: async () => {
      throw new Error("No uploads in this fixture");
    },
    media: async () => {
      throw new Error("No media in this fixture");
    },
    memories: async () => ({ entries: [], partial: false }),
    remember: async () => {},
  });
  function seed(title: string, markdown: string, agents = true): Note {
    const id = crypto.randomUUID();
    channels.set(id, {
      id,
      name: `Page ${id.slice(0, 8)}`,
      creator: viewer.pubkey,
      type: "system",
      labels: [
        NOTE_LABEL,
        `${NOTE_LABEL}.${id}`,
        ...(agents ? [AGENTS_LABEL] : []),
      ],
      roles: {
        [viewer.pubkey]: "owner",
        ...(agents ? { [carl.pubkey]: "member", [ned.pubkey]: "member" } : {}),
      },
      updated: ++tick,
      created: tick,
    });
    const template = noteTemplate({ id, channel: id }, { title, markdown });
    const event = eventDto(
      signed(viewer, {
        ...template,
        tags: template.tags.map((tag) => [...tag]),
        created_at: ++tick,
      }),
    );
    heads.set(id, event);
    revisions.push(event);
    const note = parseNote(event);
    if (!note) throw new Error("Invalid fixture page");
    return note;
  }
  async function edit(key: Key, note: Note, draft: NoteDraft) {
    const base = parseNote(heads.get(note.id) ?? note.event);
    if (!base) throw new Error("No page head");
    return client(key).publish(noteTemplate(base, draft, base));
  }
  return {
    owner,
    session: owner.session,
    viewer,
    relay,
    carl,
    ned,
    sam,
    origin,
    channels,
    profiles,
    heads,
    revisions,
    accepted,
    queries,
    client,
    seed,
    edit,
    failNextArtifact: () => {
      failArtifact = true;
    },
    loseNextReceipt: () => {
      loseArtifactReceipt = true;
    },
    unavailableInventory: () => {
      inventoryUnavailable = true;
    },
    setAgentKeys: (keys: string[]) => {
      agentKeys = keys;
    },
    dispose: owner.dispose,
  };
}
