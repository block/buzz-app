import { useEffect, useMemo, useRef, useState } from "react";
import type { PageNavigation } from "../../features/navigation/service";
import type { RelaySession } from "../../features/relay/session";
import { useMessageOpening } from "../../features/messages/use-message-opening";

/** Resolve ancestry from signed message evidence, then seek its timeline row.
 * A link's thread hint never decides where Show original message lands. */
export function useSourceOpening(
  session: RelaySession,
  channelId: string | undefined,
  navigation: PageNavigation | undefined,
) {
  const messageId =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const [resolved, setResolved] = useState<{
    request: PageNavigation;
    rootId?: string | undefined;
  }>();
  useEffect(() => {
    if (!channelId || !navigation || !messageId || navigation.signal.aborted)
      return;
    const request = navigation;
    const window = session.channels.window(channelId);
    if (
      window.status === "ready" &&
      window.freshness !== "cached" &&
      window.rows.some((row) => row.id === messageId && !row.threadRootId)
    ) {
      setResolved({ request, rootId: messageId });
      return;
    }
    let active = true;
    let view: ReturnType<RelaySession["thread"]> | undefined;
    const dispose = () => {
      active = false;
      view?.dispose();
    };
    navigation.signal.addEventListener("abort", dispose, { once: true });
    void (async () => {
      try {
        view = session.thread(channelId, messageId, { exact: true });
        await view.refresh();
        if (active && !request.signal.aborted)
          setResolved({ request, rootId: view.snapshot().root?.id });
      } catch {
        if (active && !request.signal.aborted) setResolved({ request });
      } finally {
        view?.dispose();
      }
    })();
    return () => {
      navigation.signal.removeEventListener("abort", dispose);
      dispose();
    };
  }, [session, channelId, navigation, messageId]);
  const rootId =
    resolved?.request === navigation ? resolved?.rootId : undefined;
  const visit = useRef({ navigation, request: 0 });
  if (visit.current.navigation !== navigation)
    visit.current = { navigation, request: visit.current.request + 1 };
  const inTimeline = useMessageOpening(
    session.channels,
    channelId ?? "",
    rootId,
    visit.current.request,
  );
  const failed =
    !!navigation &&
    resolved?.request === navigation &&
    (!rootId || inTimeline === false);
  useEffect(() => {
    if (failed && !navigation?.signal.aborted)
      navigation?.complete({
        status: "failed",
        reason: "not-found",
        presented: true,
      });
  }, [failed, navigation]);
  const timeline = useMemo(
    () =>
      navigation?.target.kind === "conversation" && rootId && inTimeline
        ? { ...navigation, target: { ...navigation.target, messageId: rootId } }
        : undefined,
    [navigation, rootId, inTimeline],
  );
  return {
    navigation: timeline,
    failed,
    holding: !!navigation && !failed && !timeline,
  };
}
