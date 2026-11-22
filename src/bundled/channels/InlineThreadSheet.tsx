import { useState } from "react";
import { ConversationThread } from "../../features/conversation/Conversation";
import {
  ComposerScopeProvider,
  composerHost,
  useComposerForm,
  useComposerScope,
} from "../../features/messages/composer-overlay";
import { DetailsSheet } from "../../features/messages/DetailsSheet";
import {
  INLINE_THREAD_INTRO,
  InlineThreadIntro,
  type InlineThreadIntroStep,
  introducesInlineThreads,
} from "../../features/messages/InlineThreadIntro";
import { LayerReader } from "../../features/messages/LayerReader";
import type { Seen } from "../../features/seen/service";

/** The conversation's inline thread: a dialog drawn over the conversation's
 * composer, with the thread's own reply box in its place. The address owns
 * whether it is open; this only presents it. The viewer's first one
 * introduces itself. */
export function InlineThreadSheet({
  channelId,
  rootId,
  tall,
  seen,
  close,
  moveToTab,
}: {
  channelId: string;
  rootId: string;
  /** A panel sits over it: it takes the full height until that closes. */
  tall: boolean;
  /** Records that the viewer has been shown the intro. */
  seen?: Seen | undefined;
  /** Explicit close: ✕, Escape or the scrim. */
  close(): void;
  /** Moves the thread to a side-pane tab. */
  moveToTab(): void;
}) {
  const view = useComposerScope();
  const form = useComposerForm(view?.handle);
  // Decided once per thread opening; a thread closed mid-intro shows it again.
  const [intro, setIntro] = useState<InlineThreadIntroStep | undefined>(() =>
    introducesInlineThreads(seen) ? 1 : undefined,
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const host = form ? composerHost(view?.handle) : null;
  if (!host) return null;
  return (
    <>
      <DetailsSheet
        open
        onOpenChange={(next) => {
          if (!next) close();
        }}
        host={host}
        title="Thread"
        containsComposer
        tall={tall}
        spotlight={intro}
        onSpotlightAnchor={setAnchor}
        onMoveToTab={() => {
          if (intro) seen?.mark(INLINE_THREAD_INTRO);
          moveToTab();
        }}
      >
        {/* The thread's own view, for the details and panels its rows open. */}
        <ComposerScopeProvider rootId={rootId}>
          <ConversationThread messageId={rootId} focusRequest={1} />
          <LayerReader channelId={channelId} />
        </ComposerScopeProvider>
      </DetailsSheet>
      {intro && (
        <InlineThreadIntro
          seen={seen}
          step={intro}
          anchor={anchor}
          onNext={() => setIntro(2)}
          onDone={() => setIntro(undefined)}
        />
      )}
    </>
  );
}
