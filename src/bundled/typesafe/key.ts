// The TypeSafe key saved for each community, and what is known about it.
// Native code reads and sends the keys; the app only learns whether one is
// saved.
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  communityKey,
  type DecisionProvider,
  type DecisionProviderStatus,
  type DecisionReply,
} from "../../features/decisions/service";

/** Still being read, saved, not saved, unreadable (the store refused or
 * failed the read), or saved but refused by TypeSafe. */
export type KeyState =
  | "checking"
  | "saved"
  | "missing"
  | "unreadable"
  | "refused";

export type TypeSafeNative = Readonly<{
  /** Whether `community` (a relay URL) has a saved key. */
  status(community: string): Promise<boolean>;
  /** Saves `community`'s key; it is never read back. */
  setKey(community: string, key: string): Promise<void>;
  clearKey(community: string): Promise<void>;
  /** Gives the one key saved before keys were per community to each of
   * `communities` without its own, then deletes it. */
  adopt(communities: readonly string[]): Promise<void>;
  /** Native `decide` on TypeSafe, which reads the request's community's key
   * itself. */
  decide(request: unknown): Promise<unknown>;
}>;
export const nativeTypeSafe = (): TypeSafeNative | undefined =>
  isTauri()
    ? {
        // Normalized here so the plugin always gets a promised boolean.
        status: async (community) =>
          (await invoke("jev_classifier_status", { community })) === true,
        setKey: (community, key) =>
          invoke("jev_classifier_set_key", { community, key }),
        clearKey: (community) =>
          invoke("jev_classifier_clear_key", { community }),
        adopt: (communities) => invoke("jev_classifier_adopt", { communities }),
        decide: (request) => invoke("decide", { backend: "typesafe", request }),
      }
    : undefined;

/** The joined communities, as relay URLs, or `undefined` while they are
 * still loading. */
export type JoinedCommunities = Readonly<{
  joined(): readonly string[] | undefined;
  subscribe(listener: () => void): () => void;
}>;

/** One community's key, as its Settings row shows it. */
export type CommunityKey = Readonly<{
  snapshot(): KeyState;
  subscribe(listener: () => void): () => void;
  save(key: string): Promise<void>;
  clear(): Promise<void>;
  desktop(): boolean;
}>;

const STATUS: Record<KeyState, DecisionProviderStatus> = {
  checking: "checking",
  saved: "ready",
  // A refused key still runs, and each decision reports why it failed.
  refused: "ready",
  // Native is still asked: it may find the key.
  unreadable: "unconfirmed",
  missing: "needs-setup",
};

/** Each community's TypeSafe key: what is known about it, and the provider
 * that uses it. A request answers with its own community's key; one that
 * names no community has none. */
export class TypeSafeKeys {
  /** By community key; a community not here is read when first asked
   * about. */
  private readonly states = new Map<string, KeyState>();
  /** Changes each time the owner saves or removes a community's key. A read
   * or call that started before the change may have used the old key, so
   * what it found is ignored. */
  private readonly generations = new Map<string, number>();
  private readonly views = new Map<string, CommunityKey>();
  private readonly listeners = new Set<() => void>();
  /** Whether the key saved before keys were per community has been given to
   * the communities joined then. Until it has, every key is `checking`. */
  private adopted: boolean;
  private started = false;
  constructor(
    private readonly native: TypeSafeNative | undefined,
    private readonly joined?: JoinedCommunities,
  ) {
    this.adopted = !native || !joined;
  }
  /** Once the joined communities are known, gives them the old device-wide
   * key, then reads their keys; any other community's is read when first
   * asked about. */
  load() {
    const { native, joined } = this;
    if (!native || !joined || this.started) return;
    this.started = true;
    let stop: (() => void) | undefined;
    let asked = false;
    const attempt = () => {
      const relays = joined.joined();
      if (relays === undefined || asked) return;
      asked = true;
      stop?.();
      void (relays.length ? native.adopt(relays) : Promise.resolve())
        .catch((error) =>
          console.warn(
            "The TypeSafe key could not be given to each community",
            error,
          ),
        )
        .finally(() => {
          this.adopted = true;
          this.states.clear();
          // Read each joined community's key now, as Settings and Attention
          // will ask about them.
          for (const relay of relays) this.snapshot(relay);
          this.notify();
        });
    };
    stop = joined.subscribe(attempt);
    attempt();
    if (asked) stop();
  }
  desktop = () => this.native !== undefined;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  /** `community`'s key state; asking reads it once. */
  snapshot = (community?: string): KeyState => {
    const key = communityKey(community);
    if (!this.native || community === undefined || key === undefined)
      return "missing";
    if (!this.adopted) return "checking";
    const known = this.states.get(key);
    if (known) return known;
    this.states.set(key, "checking");
    this.read(community, key);
    return "checking";
  };
  /** `community`'s key, for its Settings row. */
  for = (community: string): CommunityKey => {
    const key = communityKey(community) ?? community;
    let view = this.views.get(key);
    if (!view) {
      view = Object.freeze({
        snapshot: () => this.snapshot(community),
        subscribe: this.subscribe,
        save: (value: string) => this.save(community, value),
        clear: () => this.clear(community),
        desktop: this.desktop,
      });
      this.views.set(key, view);
    }
    return view;
  };
  private read(community: string, key: string) {
    const native = this.native;
    if (!native) return;
    const generation = this.generation(key);
    void native
      .status(community)
      .then((saved) => this.found(key, saved ? "saved" : "missing", generation))
      .catch((error) => {
        console.warn("The TypeSafe key could not be read", error);
        this.found(key, "unreadable", generation);
      });
  }
  private async save(community: string, value: string) {
    const native = this.native;
    if (!native) throw new Error("TypeSafe runs only in the desktop app");
    const key = this.keyOf(community);
    await this.change(key, () => native.setKey(community, value));
    this.set(key, "saved");
  }
  private async clear(community: string) {
    const native = this.native;
    if (!native) throw new Error("TypeSafe runs only in the desktop app");
    const key = this.keyOf(community);
    await this.change(key, () => native.clearKey(community));
    this.set(key, "missing");
  }
  private keyOf(community: string) {
    const key = communityKey(community);
    if (key === undefined) throw new Error("That is not a community");
    return key;
  }
  private generation(key: string) {
    return this.generations.get(key) ?? 0;
  }
  private async change(key: string, change: () => Promise<void>) {
    this.generations.set(key, this.generation(key) + 1);
    try {
      await change();
    } finally {
      this.generations.set(key, this.generation(key) + 1);
    }
  }
  private found(key: string, state: KeyState, generation: number) {
    if (generation === this.generation(key)) this.set(key, state);
  }
  private set(key: string, state: KeyState) {
    if (this.states.get(key) === state) return;
    this.states.set(key, state);
    this.notify();
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  /** Answers on TypeSafe. What each call finds out about the key updates
   * its state: removed outside the app, refused, or found after a failed
   * read. */
  readonly decide: DecisionProvider["decide"] = async (request) => {
    const native = this.native;
    if (!native) return { outcome: "failed", reason: "unavailable" };
    const key = communityKey(request.community);
    if (request.community === undefined || key === undefined)
      return { outcome: "failed", reason: "missing_credentials" };
    const generation = this.generation(key);
    let reply: unknown;
    try {
      reply = await native.decide(request);
    } catch (error) {
      // Tauri rejects arguments that do not deserialize before any call:
      // a malformed request. Any other rejection is the IPC itself failing.
      return {
        outcome: "failed",
        reason: (error instanceof Error
          ? error.message
          : String(error)
        ).startsWith("invalid args")
          ? "invalid_request"
          : "service_error",
      };
    }
    if (!reply || typeof reply !== "object")
      return { outcome: "failed", reason: "invalid_response" };
    const { outcome, reason, model, answers } = reply as Record<
      string,
      unknown
    >;
    if (outcome === "answered") this.found(key, "saved", generation);
    else if (reason === "missing_credentials")
      this.found(key, "missing", generation);
    else if (reason === "unauthorized") this.found(key, "refused", generation);
    // The host checks the reply's shape and answers.
    return (
      outcome === "answered" ? { outcome, model, answers } : { outcome, reason }
    ) as DecisionReply;
  };
  status = (community?: string): DecisionProviderStatus =>
    STATUS[this.snapshot(community)];
}
