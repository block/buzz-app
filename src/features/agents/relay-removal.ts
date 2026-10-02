import type { LocalEvents } from "../relay/outbox";
import type { RelaySession } from "../relay/session";

type RemovalSession = Pick<
  RelaySession,
  "outbox" | "channels" | "workSessions" | "archives"
>;

/** Remove a relay-only agent from this community: archive its identity when a
 * consent path exists, delete the owner's kind 30177 record, then try to
 * remove it from its channels. Archive and record deletion must succeed; a
 * refusal stops the later steps and Remove stays retryable. Channel removal is
 * best effort: its failure does not fail the removal. */
export async function removeRelayAgent(
  session: RemovalSession,
  viewer: string,
  pubkey: string,
  signal: AbortSignal,
): Promise<void> {
  // A retry after a later step failed does not archive again.
  if (session.archives.state(pubkey) !== "archived") {
    // No consent path (for example, an agent that never published a profile)
    // still removes the record and channel memberships.
    const consent = session.archives.writable
      ? await session.archives.consent(pubkey, signal)
      : null;
    signal.throwIfAborted();
    if (consent) await session.archives.request("archive", pubkey, signal);
  }
  await deleteAgentRecord(session, viewer, pubkey, signal);
  try {
    await removeAgentFromChannels(session, pubkey, signal);
  } catch (error) {
    signal.throwIfAborted();
    // Best effort: leave no failed channel removals in the outbox to retry.
    const outbox = session.outbox;
    await Promise.all(
      (outbox?.snapshot() ?? [])
        .filter(
          ({ event, delivery }) =>
            delivery !== "sending" &&
            event.kind === 9001 &&
            event.tags.some(
              ([name, value]) => name === "p" && value === pubkey,
            ),
        )
        .map(({ event }) => outbox?.dismiss(event.id)),
    );
    console.warn("Agent channel removal was not confirmed", error);
  }
}

/** NIP-09 coordinate deletion of the viewer's own kind 30177 agent record. */
async function deleteAgentRecord(
  session: Pick<RelaySession, "outbox">,
  viewer: string,
  pubkey: string,
  signal: AbortSignal,
) {
  const outbox = session.outbox;
  if (!outbox?.supports(5))
    throw new Error("This community cannot delete agent records.");
  await outbox.ready();
  signal.throwIfAborted();
  const coordinate = `30177:${viewer}:${pubkey}`;
  const active = () => !signal.aborted;
  const previous = outbox
    .snapshot()
    .find(
      ({ event, delivery }) =>
        delivery !== "accepted" &&
        delivery !== "seen" &&
        event.kind === 5 &&
        event.tags.some(
          ([name, value]) => name === "a" && value === coordinate,
        ),
    );
  if (previous) outbox.retry(previous.event.id, active);
  const id =
    previous?.event.id ??
    outbox.send(
      { kind: 5, content: "", tags: [["a", coordinate]] },
      undefined,
      active,
    );
  await delivered(
    outbox,
    id,
    signal,
    "Record deletion is not confirmed. Retry.",
  );
  await outbox.dismiss(id);
}

/** Base Buzz `removeAgentFromAllChannels` over the relay's rosters for this
 * agent plus the viewer's loaded channels. Resolves only once a fresh relay
 * read lists the agent in none of them; any refusal or unknown outcome throws
 * after every channel operation has settled. */
export async function removeAgentFromChannels(
  session: Pick<RelaySession, "outbox" | "channels" | "workSessions">,
  pubkey: string,
  signal: AbortSignal,
) {
  const pending = new Set([
    ...(await session.workSessions.memberChannels(pubkey, signal)),
    ...session.channels
      .list()
      .channels.filter((channel) => channel.members?.includes(pubkey))
      .map((channel) => channel.id),
  ]);
  if (!pending.size) return;
  const outbox = session.outbox;
  if (!outbox?.supports(9001))
    throw new Error("This community cannot remove agents from channels.");
  await outbox.ready();
  signal.throwIfAborted();
  // Nothing new is signed or published for a cancelled Delete.
  const active = () => !signal.aborted;
  const operations = [...pending].map((id) => {
    const previous = outbox
      .snapshot()
      .find(
        ({ event, delivery }) =>
          delivery !== "accepted" &&
          delivery !== "seen" &&
          event.kind === 9001 &&
          event.tags.some(([name, value]) => name === "h" && value === id) &&
          event.tags.some(([name, value]) => name === "p" && value === pubkey),
      );
    // Retry reuses the outbox's own operation, including an unknown result.
    if (previous) outbox.retry(previous.event.id, active);
    const operation =
      previous?.event.id ??
      outbox.send(
        {
          kind: 9001,
          content: "",
          tags: [
            ["h", id],
            ["p", pubkey],
          ],
        },
        undefined,
        active,
      );
    return operation;
  });
  // Settle every operation before reporting a failure, so no channel removal
  // is still sending when the caller cleans up or its view goes away.
  const outcomes = await Promise.allSettled(
    operations.map((id) =>
      delivered(outbox, id, signal, "Channel removal is not confirmed. Retry."),
    ),
  );
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  // Confirm each channel against its own fresh roster: a cached loaded roster
  // may still list the agent after the relay removed it.
  const listed = await Promise.all(
    [...pending].map((id) =>
      session.workSessions.listsMember(id, pubkey, signal),
    ),
  );
  const remaining = listed.filter(Boolean);
  if (remaining.length)
    throw new Error(
      `The relay did not confirm removal from ${remaining.length} channel${remaining.length === 1 ? "" : "s"}. Retry.`,
    );
  // The rosters confirm the outcome; nothing is left for the outbox to retry.
  await Promise.all(operations.map((id) => outbox.dismiss(id)));
}

function delivered(
  outbox: LocalEvents,
  id: string,
  signal: AbortSignal,
  failure: string,
) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: unknown) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () => finish(signal.reason);
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Callers that need more than relay acceptance confirm it themselves.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(new Error(item.error ?? failure));
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}
