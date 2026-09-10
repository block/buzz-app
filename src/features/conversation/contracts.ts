// FOUNDATION: Preview conversation contribution contract; data and delivery stay session-owned.
import type { ComponentType } from "react";
import type { Contribution } from "../../plugins/contributions";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

export type ComposerToolProps = Readonly<{
  session: RelaySession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  disabled: boolean;
  /** False after removal, destination change, read-only state or a rejected edit. */
  insertText(text: string): boolean;
  focus(): void;
}>;
export type ComposerTool = Readonly<{
  id: string;
  title: string;
  component: ComponentType<ComposerToolProps>;
}>;
export type InlineContent = Readonly<{
  text: string;
  message: ChannelMessage;
  reaction?: ChannelMessage["reactions"][number] | undefined;
}>;
export type InlineRange = Readonly<{ start: number; end: number }>;
export type InlineRenderer = Readonly<{
  id: string;
  title: string;
  /** UTF-16 ranges within this plain-text segment. Links are never offered. */
  matches(content: InlineContent): readonly InlineRange[];
  component: ComponentType<{
    text: string;
    content: InlineContent;
    media(url: string): string | undefined;
  }>;
}>;
export type ContributionReader<T> = Readonly<{
  snapshot(): readonly Contribution<T>[];
  subscribe(listener: () => void): () => void;
}>;
export type ConversationExtensions = Readonly<{
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
}>;
