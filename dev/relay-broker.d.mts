import type { Plugin } from "vite";
export function relayBrokerPlugin(options?: {
  authorizedViewer?: string | undefined;
  realtime?:
    | {
        endpoint: string;
        apiKey?: string | undefined;
        model?: string | undefined;
        agentPath?: string | undefined;
        mcpPath?: string | undefined;
      }
    | undefined;
  agentLibrary?: () => Promise<
    import("../src/features/agents/library").AgentLibrary
  >;
  relayUrl?: string | undefined;
  communityAliases?: string | undefined;
  identity?: () => Uint8Array;
  authority?: (
    fetch: typeof globalThis.fetch,
    relay: string,
  ) => Promise<{ relayAuthor: string; archiveAuthority?: string }>;
  upstreamFetch?: typeof fetch;
}): Plugin;
