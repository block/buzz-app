import { readView, writeView } from "../../shared/view-state";
import type { RelaySession } from "./session";

/** The public channels a community already has that every new member joins.
 * Never created here: a community without one simply has fewer. */
export const STARTER_CHANNELS = [
  "general",
  "welcome-everyone",
  "announcements",
] as const;
const DONE_KEY = "starter-channels-done";

/** Waits for the viewer's channel list, which public name search requires. */
function listReady(channels: RelaySession["channels"], signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!signal.aborted && channels.list().status !== "ready") return;
      unsubscribe();
      signal.removeEventListener("abort", check);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    const unsubscribe = channels.subscribeList(check);
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}

/** Once per viewer and community (`scope` is `origin:viewer`), joins the
 * starter channels that exist, are open and active, and that the viewer has
 * not joined. A bare join takes the channel's own join role, so an announce
 * channel makes the viewer a read-only guest. Best effort and silent: the
 * marker is saved only after a complete pass (no failed join, no partial
 * directory read), so an incomplete one retries next session. Joins run as
 * background lifecycle actions: a viewer's own channel action waits for the
 * one in flight instead of failing as busy. `signal` ends with the relay
 * session; nothing is navigated. */
export async function ensureStarterChannels(
  session: Pick<RelaySession, "channels" | "channelLifecycle">,
  scope: string,
  signal: AbortSignal,
): Promise<void> {
  const { channels, channelLifecycle: lifecycle } = session;
  if (!lifecycle.available || !channels.searchPublic) return;
  if (readView<boolean>(scope, DONE_KEY, false)) return;
  try {
    await listReady(channels, signal);
    let incomplete = false;
    // The lifecycle owner runs one action at a time, so joins are sequential.
    for (const name of STARTER_CHANNELS) {
      const { channels: found, partial } = await channels.searchPublic(name, {
        exact: true,
        signal,
      });
      // A directory read that hit its bound cannot say the starter is absent.
      if (partial) incomplete = true;
      for (const channel of found) {
        if (
          channel.channelType !== "stream" ||
          channel.archived ||
          channel.name.toLowerCase() !== name
        )
          continue;
        try {
          await lifecycle.run(
            "join",
            channel.id,
            signal,
            () => !signal.aborted,
            { background: true },
          );
        } catch {
          signal.throwIfAborted();
          incomplete = true;
        }
      }
    }
    signal.throwIfAborted();
    if (!incomplete) writeView(scope, DONE_KEY, true);
  } catch {
    /* Aborted with the session, or the relay was unavailable: retry next session. */
  }
}
