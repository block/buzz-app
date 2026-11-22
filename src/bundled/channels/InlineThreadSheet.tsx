import { ConversationThread } from "../../features/conversation/Conversation";
import {
  ComposerScopeProvider,
  composerHost,
  useComposerForm,
  useComposerScope,
} from "../../features/messages/composer-overlay";
import { DetailsSheet } from "../../features/messages/DetailsSheet";
import { LayerReader } from "../../features/messages/LayerReader";

/** The conversation's inline thread: a dialog drawn over the conversation's
 * composer, with the thread's own reply box in its place. The address owns
 * whether it is open; this only presents it. */
export function InlineThreadSheet({
  channelId,
  rootId,
  tall,
  close,
  moveToTab,
}: {
  channelId: string;
  rootId: string;
  /** A panel sits over it: it takes the full height until that closes. */
  tall: boolean;
  /** Explicit close: ✕, Escape or the scrim. */
  close(): void;
  /** Moves the thread to a side-pane tab. */
  moveToTab(): void;
}) {
  const view = useComposerScope();
  const form = useComposerForm(view?.handle);
  const host = form ? composerHost(view?.handle) : null;
  if (!host) return null;
  return (
    <DetailsSheet
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      host={host}
      title="Thread"
      containsComposer
      tall={tall}
      onMoveToTab={moveToTab}
    >
      {/* The thread's own view, for the details and panels its rows open. */}
      <ComposerScopeProvider rootId={rootId}>
        <ConversationThread messageId={rootId} focusRequest={1} />
        <LayerReader channelId={channelId} />
      </ComposerScopeProvider>
    </DetailsSheet>
  );
}
