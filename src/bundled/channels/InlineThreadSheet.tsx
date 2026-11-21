import { ConversationThread } from "../../features/conversation/Conversation";
import {
  ComposerScopeProvider,
  composerHost,
  useComposerForm,
  useComposerScope,
} from "../../features/messages/composer-overlay";
import { DetailsSheet } from "../../features/messages/DetailsSheet";

/** The conversation's inline thread: a dialog drawn over the conversation's
 * composer, with the thread's own reply box in its place. The address owns
 * whether it is open; this only presents it. */
export function InlineThreadSheet({
  rootId,
  close,
  moveToTab,
}: {
  rootId: string;
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
      onMoveToTab={moveToTab}
    >
      {/* The thread's own view, for the details its rows open. */}
      <ComposerScopeProvider rootId={rootId}>
        <ConversationThread messageId={rootId} focusRequest={1} />
      </ComposerScopeProvider>
    </DetailsSheet>
  );
}
