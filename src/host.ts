// The parts of the host this plugin uses, as it sees them. The host's own
// types are the reference: `src/plugins/author.ts` in block/buzz-app.
import type { ComponentType } from "react";
import type { SceneEvent, SceneTemplate } from "./store";

export type Browser = {
  readonly available: boolean;
  View: ComponentType<{ url: string; storage?: string }>;
};

/** An agent's own connection to the relay, handed to each tool call. */
export type BuzzClient = {
  readonly pubkey: string;
  readonly signal?: AbortSignal;
  query(filters: readonly object[]): Promise<readonly SceneEvent[]>;
  publish(template: SceneTemplate): Promise<SceneEvent>;
};
export type AddedTool = {
  name: string;
  description: string;
  inputSchema: object;
  call(
    client: BuzzClient,
    context: { channel?: string; root?: string },
    args: Record<string, unknown>,
  ): Promise<string>;
};

export type Session = {
  readonly lifetimeSignal: AbortSignal;
  readonly viewer?: string;
  readonly channels?: {
    list(): {
      channels: readonly { id: string; channelType?: string }[];
    };
  };
  readonly names?: {
    subscribe(listener: () => void): () => void;
    snapshot(): unknown;
    resolve(pubkey: string, fallback: string): string | undefined;
  };
  snapshotRead?(
    filters: readonly object[],
    options: { signal?: AbortSignal },
  ): Promise<readonly SceneEvent[]>;
  configArtifactWriter?: {
    sign(
      template: SceneTemplate & { created_at: number },
      signal: AbortSignal,
    ): Promise<SceneEvent>;
    publish(event: SceneEvent, signal: AbortSignal): Promise<unknown>;
  };
  artifacts: {
    follow(
      channels: readonly string[],
      listener: (events: readonly SceneEvent[]) => void,
    ): () => void;
  };
};
export type RelaySnapshot = {
  status: string;
  viewer?: string;
  scope?: string;
  generation?: number;
  session: Session;
};

/** What the host hands a panel's button in a conversation's header. */
export type LauncherProps = {
  context: { channelId: string };
  /** Whether this panel's tab is the one showing. */
  pressed: boolean;
  toggle(target: string): void;
};
export type PanelProps = {
  channelContext?: { channelId: string; scope: string };
  context?: { channelId?: string };
  /** What this tab was opened for. */
  target?: string;
  /** Closes this tab. */
  close?(): void;
};

export type PluginContext = {
  react: unknown;
  browser: Browser;
  panels: {
    register(panel: object): void;
    requestOpen(request: {
      target: string;
      channelId: string;
      rootId?: string;
    }): boolean;
    /** A hook for a panel's component: names its tab. Newer hosts only. */
    useTabTitle?(label: string): void;
  };
  relay: {
    subscribe(listener: () => void): () => void;
    snapshot(): RelaySnapshot;
  };
  agents: {
    addTool(tool: AddedTool): void;
    addInstructions(instructions: { id: string; text: string }): void;
  };
  reflect: { get(name: string): unknown };
  effect(start: () => () => void): void;
  provide?(name: string, value: unknown): void;
};
