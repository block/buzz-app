/** Internal panel target, not an OS deep link or an access grant. */
export type ActivitySelection = Readonly<{
  agent: string;
  channelId?: string;
  messageId?: string;
  requestId?: string;
  view?: "profile";
}>;
export function activityTarget(
  agent: string,
  channelId?: string,
  messageId?: string,
  requestId?: string,
): string {
  const query = new URLSearchParams({ agent });
  if (channelId) query.set("channel", channelId);
  if (messageId) query.set("message", messageId);
  if (requestId) query.set("request", requestId);
  return `buzz:agent-activity?${query}`;
}
/** Private host presentation target for the Profile tab, not an OS/deep link.
 * Identity is fixed; request/response scope is never accepted in this mode.
 * Each tab mount starts at the originating channel; capture stays session-owned. */
export function profileActivityTarget(
  agent: string,
  channelId?: string,
): string {
  return `${activityTarget(agent, channelId)}&view=profile`;
}
export function activitySelection(
  target: string,
): ActivitySelection | undefined {
  try {
    const url = new URL(target);
    const params = url.searchParams;
    const agent = params.get("agent");
    const channelId = params.get("channel");
    const messageId = params.get("message");
    const requestId = params.get("request");
    const view = params.get("view");
    if (
      url.protocol !== "buzz:" ||
      url.pathname !== "agent-activity" ||
      url.host ||
      url.hash ||
      !agent ||
      !/^[0-9a-f]{64}$/.test(agent) ||
      params.getAll("agent").length !== 1 ||
      params.getAll("channel").length > 1 ||
      params.getAll("message").length > 1 ||
      params.getAll("request").length > 1 ||
      params.getAll("view").length > 1 ||
      (view !== null &&
        (view !== "profile" || messageId !== null || requestId !== null)) ||
      (requestId !== null &&
        (!channelId ||
          messageId !== null ||
          !/^[0-9a-f]{64}$/.test(requestId))) ||
      (messageId !== null &&
        (!channelId || !/^[0-9a-f]{64}$/.test(messageId))) ||
      [...params.keys()].some(
        (key) =>
          !["agent", "channel", "message", "request", "view"].includes(key),
      ) ||
      (channelId !== null && (!channelId || channelId.length > 256))
    )
      return;
    return {
      agent,
      ...(channelId !== null ? { channelId } : {}),
      ...(messageId !== null ? { messageId } : {}),
      ...(requestId !== null ? { requestId } : {}),
      ...(view === "profile" ? { view } : {}),
    };
  } catch {
    return;
  }
}
