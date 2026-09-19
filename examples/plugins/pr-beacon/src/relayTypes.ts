import type { RelayData, RelaySnapshot } from "@buzz/author";

// Derived structurally from the two relay types @buzz/author actually
// exports (RelayData/RelaySnapshot) — RelaySession/ChannelSummary/etc. have
// no exported names of their own, so these aliases are the only way to
// reference their shapes without importing host-internal modules.
export type { RelayData };
export type RelaySession = RelaySnapshot["session"];
export type ChannelSummary = ReturnType<
  RelaySession["channels"]["list"]
>["channels"][number];
export type AgentIdentity = ReturnType<
  RelaySession["agentLibrary"]["snapshot"]
>["identities"][number];
export type ThreadReader = ReturnType<RelaySession["thread"]>;
export type ThreadSnapshot = ReturnType<ThreadReader["snapshot"]>;
export type ChannelMessage = ThreadSnapshot["replies"][number];

// Which agent + channel to send a diff to for a summary. Deliberately plain
// React state, never persisted: it must not survive a relay reconnect or
// carry over between communities (a channel/agent id from one community is
// meaningless, or worse misleading, in another).
export type AgentSummarySelection = {
  agentPubkey: string;
  channelId: string;
} | null;
