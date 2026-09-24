import type { Communities } from "../communities/service";
import { communityDestination } from "../communities/destination";
import type { RelaySession } from "../relay/session";
import type { AgentControl } from "./control";

/** Capture the send's community, not whichever page is selected at confirmation. */
export function bindAgentMentions(
  control: AgentControl,
  communities: Communities,
) {
  let session: RelaySession | undefined;
  let identity = "";
  const lifetime = new AbortController();
  let stopSend = () => {};
  const update = () => {
    const client = communities.snapshot();
    const relay = communities.relay.snapshot();
    const origin = client.selected
      ? communityDestination(client.selected).url
      : "";
    const next = `${client.viewer}:${origin}:${relay.status}`;
    if (session === relay.session && identity === next) return;
    stopSend();
    session = relay.session;
    identity = next;
    if (
      relay.status !== "ready" ||
      !origin ||
      !client.viewer ||
      relay.viewer !== client.viewer
    )
      return;
    const outbox = relay.session.outbox;
    stopSend =
      outbox?.observeSend((event, signal) => {
        if (event.kind !== 9 || event.pubkey !== client.viewer) return;
        const pubkeys = [
          ...new Set(
            event.tags.flatMap(([tag, key]) =>
              tag === "p" && key ? [key] : [],
            ),
          ),
        ];
        if (!pubkeys.length) return;
        const wake = control.prepareMention(
          pubkeys,
          origin,
          event.created_at,
          AbortSignal.any([lifetime.signal, signal]),
        );
        return (pending) => {
          const now = communities.snapshot();
          if (
            now.viewer === client.viewer &&
            outbox.supports(9) &&
            now.memberships.some(
              (item) => communityDestination(item.id).url === origin,
            )
          )
            void wake(
              Math.min(
                event.created_at,
                ...pending
                  .filter(
                    (item) =>
                      item.kind === 9 &&
                      item.pubkey === client.viewer &&
                      item.tags.some(
                        ([tag, key]) =>
                          tag === "p" && !!key && pubkeys.includes(key),
                      ),
                  )
                  .map((item) => item.created_at),
              ),
            );
        };
      }) ?? (() => {});
  };
  const stop = communities.relay.subscribe(update);
  const stopCommunity = communities.subscribe(update);
  update();
  return () => {
    lifetime.abort();
    stopSend();
    stop();
    stopCommunity();
  };
}
