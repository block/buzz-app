import { Service, type Context } from "@deepseek-ai/cordis";
import type { ProfileQueries } from "../relay/profile-directory";
import type { AgentLibrary } from "../agents/library";
import { createContributions } from "../../plugins/contributions";

export type NameSource = {
  relayUrl?: string | undefined;
  profiles: ProfileQueries;
  agentLibrary: {
    snapshot(): AgentLibrary & { status: string };
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
    retain(): () => void;
  };
};
export type NameProvider = {
  id: string;
  resolve(source: NameSource, pubkey: string): string | undefined;
  activate(source: NameSource): undefined | (() => void);
  subscribe?(listener: () => void): () => void;
};
export type IdentityName = Readonly<{
  name: string;
  source: "agent-directory" | "public-profile";
}>;
export interface IdentityNameView {
  lookup(pubkey: string): IdentityName | undefined;
  resolve(pubkey: string, fallback?: string): string | undefined;
  snapshot(): number;
  subscribe(listener: () => void): () => void;
}
export interface IdentityNames {
  bind(source: NameSource): IdentityNameView & { dispose(): void };
  register(provider: NameProvider): void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    identityNames: IdentityNames;
  }
}

/** Stable injected service; provider replacement never replaces consumers' handle. */
export class IdentityNamesService extends Service implements IdentityNames {
  private readonly entries;
  private readonly registrations = new Set<object>();

  constructor(ctx: Context) {
    super(ctx, "identityNames");
    this.entries = createContributions<NameProvider>(ctx);
  }
  register(provider: NameProvider) {
    if (this.registrations.size)
      throw new Error("An identity name provider is already registered");
    const token = {};
    const registrations = this.registrations;
    this.ctx.effect(() => {
      registrations.add(token);
      return () => {
        registrations.delete(token);
      };
    });
    this.entries.register(this.ctx, provider);
  }
  bind(source: NameSource) {
    return bindNames(source, this.entries);
  }
}

/** Standalone sessions retain the same default without a plugin runtime. */
export function bindNames(
  source: NameSource,
  providers?: {
    snapshot(): readonly NameProvider[];
    subscribe(listener: () => void): () => void;
  },
): IdentityNameView & { dispose(): void } {
  let closed = false;
  let revision = 0;
  let provider: NameProvider | undefined;
  let stopLibrary: (() => void) | undefined;
  let stopProvider: (() => void) | undefined;
  let deactivate: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const emit = () => {
    if (closed) return;
    revision++;
    for (const listener of listeners) listener();
  };
  const select = () => {
    if (closed) return;
    const entries = providers?.snapshot() ?? [];
    // Competing providers do not acquire last-writer authority.
    const next = entries.length === 1 ? entries[0] : undefined;
    if (provider === next) return;
    deactivate?.();
    deactivate = undefined;
    stopLibrary?.();
    stopLibrary = undefined;
    stopProvider?.();
    stopProvider = undefined;
    provider = next;
    if (provider) {
      stopLibrary = source.agentLibrary.subscribe(emit);
      stopProvider = provider.subscribe?.(emit);
      deactivate = provider.activate(source);
    }
    emit();
  };
  const stops = [source.profiles.subscribe(emit)];
  if (providers) stops.push(providers.subscribe(select));
  select();
  const lookup = (pubkey: string): IdentityName | undefined => {
    if (closed) return undefined;
    const local = provider?.resolve(source, pubkey);
    if (local) return { name: local, source: "agent-directory" };
    const name = source.profiles.snapshot().get(pubkey)?.name;
    return name ? { name, source: "public-profile" } : undefined;
  };
  return {
    lookup,
    resolve(pubkey, fallback) {
      return lookup(pubkey)?.name ?? fallback;
    },
    snapshot: () => revision,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      closed = true;
      provider = undefined;
      deactivate?.();
      stopLibrary?.();
      stopProvider?.();
      for (const stop of stops) stop();
      listeners.clear();
    },
  };
}
