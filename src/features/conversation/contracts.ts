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
  /** Insert a catalog-backed custom emoji without exposing its shortcode as draft text. */
  insertCustomEmoji(shortcode: string): boolean;
  /** Atomically insert display text and explicit notification intent at the caret.
   * Prose never resolves to identities. Membership is checked by session delivery.
   * Like insertText, this command is revoked with the tool/destination lifetime. */
  insertMention(recipient: Readonly<{ pubkey: string; name: string }>): boolean;
  focus(): void;
}>;
export type ComposerTool = Readonly<{
  id: string;
  title: string;
  /** Lower values appear first; defaults to zero. Equal values sort by contribution key. */
  order?: number;
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
  completions?: ContributionReader<ComposerCompletion>;
}>;

/** Immutable host-issued evidence, scoped to one live editor observation. */
export type ComposerObservation = Readonly<{
  revision: number;
  text: string;
  start: number;
  end: number;
}>;
export type CompletionContext = Pick<
  ComposerToolProps,
  "session" | "scope" | "channelId" | "threadRootId"
>;
export type CompletionQuery = Readonly<{
  start: number;
  end: number;
  query: string;
}>;
export type CompletionEdit =
  | Readonly<{
      text: string;
      mention?: never;
      customEmoji?: Readonly<{ shortcode: string }>;
    }>
  | Readonly<{
      mention: Readonly<{ pubkey: string; name: string }>;
      text?: never;
    }>;
export type CompletionSuggestion = Readonly<{
  id: string;
  label: string;
  detail?: string;
  /** Decorative presentation only; the host owns option semantics and interaction. */
  preview?: import("react").ReactNode;
  edit: CompletionEdit;
}>;
export type CompletionResult = Readonly<{
  items: readonly CompletionSuggestion[];
  status?: string;
  /** Optional explicit recovery. A new query or disposal revokes this action. */
  retry?: () => void;
}>;
export type ComposerCompletionProps = CompletionContext &
  Readonly<{
    observation: ComposerObservation;
    query: CompletionQuery;
    /** Publishes only for this query/lifetime; returns false after revocation.
     * Cleanup of the returned disposer withdraws that exact publication. */
    publish(result: CompletionResult): (() => void) | false;
  }>;
export type ComposerCompletion = Readonly<{
  id: string;
  title: string;
  order?: number;
  /** Pure syntax matcher. Host prefers the closest trigger; order/key break ties. */
  match(
    observation: ComposerObservation,
    context: CompletionContext,
  ): CompletionQuery | null;
  component: ComponentType<ComposerCompletionProps>;
}>;
