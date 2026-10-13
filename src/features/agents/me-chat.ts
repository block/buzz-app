import type { RelayData } from "../relay/service";

/** Whether a native agent's mention continues its owner's Me chat: one
 * channel-scoped conversation that posts at channel top level. Only the
 * owner's own placement in the agent's community counts; another member's
 * filing never does, and DMs keep their own routing. An unreadable placement
 * is unknown, not Messages, so the turn fails rather than guess. Callers
 * freeze the answer for the turn it admits. */
export async function meChat(
  relay: () => RelayData | undefined,
  owner: string,
  channelId: string,
  signal: AbortSignal,
) {
  const snapshot = relay()?.snapshot();
  if (snapshot?.status !== "ready" || snapshot.viewer !== owner) return false;
  const { session, scope } = snapshot;
  if (
    session.channels.list().channels.find((row) => row.id === channelId)
      ?.channelType === "dm"
  )
    return false;
  const placement = session.mePlacement;
  const status = () => placement.snapshot().status;
  if (status() === "unavailable") return false;
  if (status() !== "ready") await placement.refresh();
  signal.throwIfAborted();
  const after = relay()?.snapshot();
  if (
    after?.status !== "ready" ||
    after.session !== session ||
    after.scope !== scope ||
    after.viewer !== owner
  )
    throw new Error("The community changed");
  if (status() !== "ready")
    throw new Error(
      placement.snapshot().error ?? "Your Me chats could not be read",
    );
  return placement.has(channelId);
}
