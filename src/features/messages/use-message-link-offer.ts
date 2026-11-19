import { useLayoutEffect, useState } from "react";
import { messageLinkOffer, type PageNavigation } from "../navigation/service";

/** Hold the ordinary reveal only while the admitted link has an offer pending. */
export function useMessageLinkOffer(
  navigation: PageNavigation | undefined,
  verifiedRoot: () => string | undefined,
  checking = false,
) {
  const offer = messageLinkOffer(navigation);
  const [settled, setSettled] = useState<typeof offer>();
  const hasTime = !!offer?.remaining();
  const root = hasTime ? verifiedRoot() : undefined;
  const awaitingRoot = hasTime && !root && checking;
  useLayoutEffect(() => {
    if (!offer || settled === offer) return;
    if (!root) {
      if (!awaitingRoot) return;
      // A reply can be ready independently of its root on older relays.
      const timeout = setTimeout(
        () => setSettled(() => offer),
        Math.min(250, offer.remaining()),
      );
      return () => clearTimeout(timeout);
    }
    const request = new AbortController();
    // A tab can replace a reader in the same commit that verifies the target.
    // Let that reader's cleanup run before invoking a page's resolver.
    void Promise.resolve().then(async () => {
      if (request.signal.aborted) return;
      try {
        await offer.run(root, () => verifiedRoot() === root, request.signal);
      } finally {
        if (!request.signal.aborted) setSettled(() => offer);
      }
    });
    return () => request.abort();
  }, [offer, root, settled, verifiedRoot, awaitingRoot]);
  return !!offer && settled !== offer && (!!root || awaitingRoot);
}
