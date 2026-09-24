/** The status write surface is only the NIP-38 general coordinate. */
export function validStatusTemplate(event) {
  if (
    event?.kind !== 30315 ||
    typeof event.content !== "string" ||
    event.content.length > 100 ||
    /[\r\n]/.test(event.content) ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length > 3 ||
    event.tags.some(
      (tag) =>
        !Array.isArray(tag) ||
        tag.length !== 2 ||
        tag.some((value) => typeof value !== "string"),
    )
  )
    return false;
  const keys = event.tags.map(([key]) => key);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !["d", "emoji", "expiration"].includes(key))
  )
    return false;
  if (!event.tags.some(([key, value]) => key === "d" && value === "general"))
    return false;
  const emoji = event.tags.find(([key]) => key === "emoji")?.[1];
  if (
    emoji !== undefined &&
    (!emoji.trim() || emoji.length > 100 || /[\r\n]/.test(emoji))
  )
    return false;
  const expiration = event.tags.find(([key]) => key === "expiration")?.[1];
  if (
    expiration !== undefined &&
    (!/^\d+$/.test(expiration) ||
      !Number.isSafeInteger(Number(expiration)) ||
      Number(expiration) < 0)
  )
    return false;
  // Clearing is a durable replacement without an expiration.
  return !!(event.content.trim() || emoji || expiration === undefined);
}
