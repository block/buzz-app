import { useSyncExternalStore, type ReactNode } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { ContributionReader, MessageRenderer } from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { WithTargetOpener } from "./opener";

const EMPTY: readonly never[] = [];
const NONE = { snapshot: () => EMPTY, subscribe: () => () => {} };

/** The renderer for `message`: the first active match. Throwing matchers are skipped. */
export function useMessageRenderer(
  registry: ContributionReader<MessageRenderer> | undefined,
  message: ChannelMessage,
) {
  const reader = registry ?? NONE;
  const renderers = useSyncExternalStore(
    reader.subscribe,
    reader.snapshot,
    reader.snapshot,
  );
  return renderers.find((entry) => {
    try {
      return entry.matches(message);
    } catch {
      return false;
    }
  });
}

/** First active match wins; a broken optional renderer leaves the host fallback. */
export function MessageBody({
  registry,
  message,
  children,
  onFailed,
}: {
  registry: ContributionReader<MessageRenderer>;
  message: ChannelMessage;
  children: ReactNode;
  /** Called with the renderer that failed, after the fallback replaces it. */
  onFailed?: (renderer: MessageRenderer) => void;
}) {
  const renderer = useMessageRenderer(registry, message);
  return (
    <MessageCard
      registry={registry}
      renderer={renderer}
      message={message}
      onFailed={onFailed}
    >
      {children}
    </MessageCard>
  );
}

/** Draws an already selected renderer, so its caller can rely on the same choice. */
export function MessageCard({
  registry,
  renderer,
  message,
  children,
  onFailed,
}: {
  registry: ContributionReader<MessageRenderer>;
  renderer: ReturnType<typeof useMessageRenderer>;
  message: ChannelMessage;
  children: ReactNode;
  /** Called with the renderer that failed, after the fallback replaces it. */
  onFailed?: ((renderer: MessageRenderer) => void) | undefined;
}) {
  if (!renderer) return children;
  return (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${message.channelId}:${message.id}`}
      fallback={children}
      onFailed={onFailed && (() => onFailed(renderer))}
    >
      <WithTargetOpener
        component={renderer.component}
        props={{ message }}
        registry={registry}
        entry={renderer}
      />
    </ContributionBoundary>
  );
}
