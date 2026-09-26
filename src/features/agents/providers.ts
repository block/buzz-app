// Agent providers decide what a provider-backed agent does with admitted work.
// Identity, custody, admission and replay stay host-owned (see triggers.ts).
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type { InvokeRequest, InvokeResult } from "./control";

/** One admitted mention, already checked against owner membership and respond-to. */
export type AgentWork = Readonly<{
  /** Durable per-agent delivery identity. The host hands each one out at most once. */
  deliveryId: string;
  agent: Readonly<{
    id: string;
    pubkey: string;
    name: string;
    relayUrl: string;
    config: Readonly<Record<string, string>>;
  }>;
  /** Owner whose client admitted this work. */
  owner: string;
  channelId: string;
  /** Buzz reply destination: the thread root, or the message itself when top-level. */
  replyTo: string;
  threadRootId: string | null;
  message: Readonly<{
    id: string;
    author: string;
    content: string;
    createdAt: number;
    tags: readonly (readonly string[])[];
  }>;
}>;
export type AgentProviderHost = {
  /** Run one process as this agent, with only its credential. Rejects in the browser. */
  invoke(
    request: Omit<InvokeRequest, "id" | "provider">,
  ): Promise<InvokeResult>;
  /** Aborted when the owner's session for this community ends. */
  signal: AbortSignal;
};
export type AgentProviderSetupProps = {
  value: Readonly<Record<string, string>>;
  onChange(value: Record<string, string>): void;
  disabled: boolean;
};
export type AgentProvider = {
  id: string;
  title: string;
  description?: string;
  /** Optional creation UI; its value is saved as the agent's provider settings. */
  setup?: ComponentType<AgentProviderSetupProps>;
  defaultConfig?: Readonly<Record<string, string>>;
  handle(work: AgentWork, host: AgentProviderHost): Promise<void>;
};
export type AgentProviders = {
  snapshot(): readonly Contribution<AgentProvider>[];
  subscribe(listener: () => void): () => void;
  register(provider: AgentProvider): void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    agentProviders: AgentProviders;
  }
}
export class AgentProvidersService extends Service implements AgentProviders {
  private readonly entries;
  constructor(ctx: Context) {
    super(ctx, "agentProviders");
    this.entries = createContributions<AgentProvider>(ctx);
  }
  snapshot = () => this.entries.snapshot();
  subscribe = (listener: () => void) => this.entries.subscribe(listener);
  register(provider: AgentProvider) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(provider.id) ||
      !provider.title?.trim() ||
      typeof provider.handle !== "function" ||
      (provider.setup !== undefined && typeof provider.setup !== "function")
    )
      throw new Error("Agent provider needs an id, title and handle function");
    this.entries.register(this.ctx, provider);
  }
}
