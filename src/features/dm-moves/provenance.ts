import type { EventData } from "../relay/events";
const MOVE_TAG = "buzz:dm-move";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
/** Original chronology is display metadata, never the signed publication time or read cursor. */
export function movedSource(event: Pick<EventData, "tags">) {
  const tags = event.tags.filter((t) => t[0] === MOVE_TAG);
  const t = tags[0];
  if (
    tags.length !== 1 ||
    !t ||
    t.length !== 4 ||
    !uuid.test(t[1] ?? "") ||
    !hex.test(t[2] ?? "") ||
    !/^(0|[1-9]\d{0,12})$/.test(t[3] ?? "")
  )
    return;
  const ms = Number(t[3]);
  return integer(ms)
    ? { move: t[1] as string, original: t[2] as string, ms }
    : undefined;
}
