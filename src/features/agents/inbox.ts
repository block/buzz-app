import type { ChannelSummary } from "../relay/contracts";
import { ByteLru } from "../relay/budget";
import { DiscoveryState } from "../relay/discovery";
import {
  hasEventProof,
  type ReadFilter,
  type RelayEvent,
} from "../relay/events";
import { createRelayReader } from "../relay/reader";
import type { AgentReads } from "./reads";

export class AgentInbox {
  private readonly channels = new ByteLru<ChannelSummary>(128, 2 * 1024 * 1024);
  private readonly listeners = new Set<() => void>();
  private readonly reader;
  readonly reads: AgentReads;
  private nextRead = Date.now() + Math.floor(Math.random() * 5_000);
  private retryDelay = 0;

  due() {
    return Date.now() >= this.nextRead;
  }

  constructor(
    private readonly owner: AgentReads,
    private readonly pubkey: string,
    private readonly authority: string,
    query: (filters: readonly ReadFilter[]) => Promise<RelayEvent[]>,
    private readonly lifetime: AbortSignal,
  ) {
    this.reader = createRelayReader({
      viewer: pubkey,
      relayAuthor: authority,
      media: () => undefined,
      query: async (filters, signal) => {
        lifetime.throwIfAborted();
        signal?.throwIfAborted();
        const events = await query(filters);
        lifetime.throwIfAborted();
        signal?.throwIfAborted();
        return events;
      },
    });
    lifetime.addEventListener("abort", () => this.reader.dispose(), {
      once: true,
    });
    this.reads = {
      ...owner,
      channel: async (id) => {
        const known = await owner.channel(id);
        if (known) return known;
        await this.resolve([id], lifetime).catch((error) => {
          if (!lifetime.aborted)
            console.warn("Agent inbox could not refresh channel facts", error);
        });
        const channel = this.channel(id);
        return (
          channel && {
            name: channel.name,
            ...(channel.description ? { about: channel.description } : {}),
            dm: channel.channelType === "dm",
            members: channel.members ?? [],
          }
        );
      },
      read: async (filters, signal) => {
        const ids = filters.flatMap((filter) => filter["#h"] ?? []);
        const known = await Promise.all(ids.map((id) => owner.channel(id)));
        return known.some((channel) => !channel)
          ? this.reader.reader.read(filters, {
              signal: AbortSignal.any([lifetime, signal]),
            })
          : owner.read(filters, signal);
      },
      channelLabel: (id) => {
        const channel = this.channel(id);
        return (
          owner.channelLabel(id) ??
          (channel && {
            name: channel.name,
            ...(channel.private ? { private: channel.private } : {}),
            ...(channel.channelType
              ? { channelType: channel.channelType }
              : {}),
          })
        );
      },
      subscribeChannels: (listener) => {
        this.listeners.add(listener);
        const stop = owner.subscribeChannels(listener);
        return () => {
          this.listeners.delete(listener);
          stop();
        };
      },
    };
  }

  channel(id: string) {
    return this.lifetime.aborted ? undefined : this.channels.get(id);
  }

  /** Resolves the channels, returning those the relay gave only part of. */
  private async resolve(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    if (!ids.length) return [];
    const events = await this.reader.reader.read(
      [
        {
          kinds: [39000, 39002],
          authors: [this.authority],
          "#d": [...new Set(ids)],
          limit: ids.length * 2,
        },
      ],
      { signal: AbortSignal.any([this.lifetime, signal]), fresh: true },
    );
    const kinds = new Map<string, Set<number>>();
    const discovery = new DiscoveryState(
      this.pubkey,
      this.authority,
      2 * 1024 * 1024,
    );
    for (const event of events)
      if (hasEventProof(event)) {
        discovery.accept(event);
        const id = event.tags.find(([key]) => key === "d")?.[1];
        if (id) kinds.set(id, (kinds.get(id) ?? new Set()).add(event.kind));
      }
    for (const id of ids) {
      this.channels.delete(id);
      const channel = discovery.get(id);
      if (discovery.authorized(id) && channel?.channelType === "dm")
        this.channels.set(id, channel);
    }
    for (const listener of this.listeners) listener();
    return ids.filter((id) => kinds.get(id)?.size === 1);
  }

  private async read(filter: ReadFilter, signal: AbortSignal) {
    const events = await this.reader.reader.read([filter], {
      signal: AbortSignal.any([this.lifetime, signal]),
      priority: "background",
      fresh: true,
    });
    const ids = [
      ...new Set(
        events.flatMap((event) =>
          event.tags.flatMap(([key, value]) =>
            key === "h" && value ? [value] : [],
          ),
        ),
      ),
    ];
    const known = await Promise.all(ids.map((id) => this.owner.channel(id)));
    const partial = await this.resolve(
      ids.filter((_, index) => !known[index]),
      signal,
    );
    return { events, partial };
  }

  async readAsAgent(filter: ReadFilter, signal: AbortSignal) {
    return (await this.read(filter, signal)).events;
  }

  async mentions(filter: ReadFilter, signal: AbortSignal) {
    try {
      const { events, partial } = await this.read(filter, signal);
      if (partial.length)
        throw new Error("The relay returned only part of a DM's details");
      if (events.length < filter.limit) this.schedule(0);
      return events;
    } catch (error) {
      if (!signal.aborted && !this.lifetime.aborted)
        this.schedule(
          Math.min(this.retryDelay ? this.retryDelay * 2 : 30_000, 240_000),
        );
      throw error;
    }
  }

  private schedule(retryDelay: number) {
    this.retryDelay = retryDelay;
    const delay = retryDelay || 30_000;
    this.nextRead =
      Date.now() + delay + Math.floor((Math.random() * delay) / 4);
  }
}
