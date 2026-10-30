export type BrowserConversation = Readonly<{
  channel: string;
  root?: string | undefined;
}>;

/** One-time assignment owned by the plugin only for an agent-created page. */
export type BrowserInitialShare = Readonly<{
  agent: string;
  claim(): boolean;
  valid(): boolean;
  prepare(): Promise<void>;
  complete(error?: unknown): void;
}>;
