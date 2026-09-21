import type { AgentControl } from "./control";
import { sameCommunityAgents } from "./mention-context";
import type { RelaySession } from "../relay/session";
import type { Outbox } from "../relay/outbox";

/** Only explicit selected local agents may be added; ordinary member validation stays in the session. */
export async function enrollMentionedAgents(
  session: RelaySession,
  scope: string,
  channelId: string,
  pubkeys: readonly string[],
  control: AgentControl | undefined,
  signal: AbortSignal,
) {
  const channel = () =>
    session.channels.list().channels.find((item) => item.id === channelId);
  const missing = () =>
    [...new Set(pubkeys)].filter((key) => !channel()?.members?.includes(key));
  if (!missing().length) return;
  const outbox = session.outbox;
  if (!outbox) throw new Error("This connection cannot add agents.");
  const viewer = scope.slice(-64);
  const check = () => {
    signal.throwIfAborted();
    const current = channel();
    const state = control?.snapshot();
    const agents = sameCommunityAgents(
      state?.status === "ready" ? (state.data?.agents ?? []) : [],
      scope,
    );
    if (
      !outbox?.supports(9000) ||
      !outbox.supports(9) ||
      !current?.members?.includes(viewer) ||
      current.archived ||
      (current.channelType !== "stream" && current.channelType !== "forum") ||
      missing().some((key) => !agents.some((agent) => agent.pubkey === key))
    )
      throw new Error(
        "Could not add the selected agent. Check its community and channel membership; your message has not been sent.",
      );
  };
  check();
  await session.read([{ kinds: [39002], "#d": [channelId], limit: 1 }], {
    fresh: true,
    signal,
  });
  check();
  for (const pubkey of missing()) {
    check();
    if (channel()?.members?.includes(pubkey)) continue;
    const previous = outbox
      .snapshot()
      .find(
        (item) =>
          item.event.kind === 9000 &&
          item.event.tags.some(
            ([tag, value]) => tag === "h" && value === channelId,
          ) &&
          item.event.tags.some(
            ([tag, value]) => tag === "p" && value === pubkey,
          ),
      );
    if (
      previous?.delivery === "failed" &&
      Date.now() / 1000 - previous.event.created_at >= 15 * 60
    )
      throw new Error(
        `This agent-add request expired. Open Outbox, remove the Not sent “Add agent ${pubkey.slice(0, 12)}” item, then press Send again. Your draft is kept.`,
      );
    const id =
      previous?.event.id ??
      outbox.send({
        kind: 9000,
        content: "",
        tags: [
          ["h", channelId],
          ["p", pubkey],
          ["role", "bot"],
        ],
      });
    // Retry the same signed operation after an unknown result, never create a duplicate request.
    if (
      previous &&
      (previous.delivery === "failed" || previous.delivery === "unknown")
    )
      outbox.retry(id);
    await waitForEnrollment(outbox, id, signal);
    check();
    await session.read([{ kinds: [39002], "#d": [channelId], limit: 1 }], {
      fresh: true,
      signal,
    });
    check();
    if (!channel()?.members?.includes(pubkey))
      throw new Error(
        "Agent addition is not confirmed yet. Your message was not sent; press Send to check again.",
      );
  }
}

function waitForEnrollment(outbox: Outbox, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      if (error) reject(error);
      else resolve();
    };
    const cancelled = () =>
      finish(new Error("Sending cancelled; your draft is kept."));
    const changed = () => {
      const operation = outbox.snapshot().find((item) => item.event.id === id);
      // Confirmed echoes leave the outstanding outbox; the fresh roster is still required.
      if (
        !operation ||
        operation.delivery === "accepted" ||
        operation.delivery === "seen"
      )
        finish();
      else if (operation.delivery !== "sending")
        finish(
          new Error(
            `Could not confirm agent addition. Your message was not sent; press Send to retry.${operation.error ? ` ${operation.error}` : ""}`,
          ),
        );
    };
    stop = outbox.subscribe(changed);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else changed();
  });
}
