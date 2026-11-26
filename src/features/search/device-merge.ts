import type { SearchMessage } from "../../app/shell/useSearchMessages";

/**
 * How ⌘K's message rows combine this device's matches (C1) with the relay's
 * (C2), so the list changes at most once for a search:
 *
 * - Device rows show on every key and follow the index until the relay is
 *   asked or the person moves through the list. Then they hold still.
 * - Relay rows join below once, without the ones already shown. More
 *   messages add below. With no device rows, relay rows show as they arrive.
 * - A failed or slow relay leaves the device rows as they are.
 *
 * A re-ranker orders the merged list afterwards (`useMessageRerank`).
 */
export type DeviceMerge = Readonly<{
  /** The search: its text within its conversation. */
  key: string;
  device: readonly SearchMessage[];
  /** The relay was asked, or the person moved: device rows hold still. */
  held: boolean;
}>;

const sameIds = (a: readonly SearchMessage[], b: readonly SearchMessage[]) =>
  a.length === b.length && a.every((message, i) => message.id === b[i]?.id);

/** The next merge. Returns `previous` itself when nothing changed. */
export function nextDeviceMerge(
  previous: DeviceMerge | undefined,
  input: {
    key: string;
    device: readonly SearchMessage[];
    /** The relay was asked for this search, or answered it. */
    asked: boolean;
    moved: boolean;
  },
): DeviceMerge {
  const held = input.asked || input.moved;
  if (previous?.key !== input.key)
    return { key: input.key, device: input.device, held };
  if (previous.held) return previous;
  // Holding keeps the rows already shown: the relay's hits reach the index
  // as they arrive, and would otherwise move in above.
  if (held) return { ...previous, held };
  return sameIds(previous.device, input.device)
    ? previous
    : { ...previous, device: input.device };
}

/** Device rows that are still shown, then the relay's other rows. */
export function mergedMessages(
  merge: DeviceMerge,
  relay: readonly SearchMessage[],
  shown: (message: SearchMessage) => boolean,
) {
  const device = new Set(merge.device.map(({ id }) => id));
  return [
    ...merge.device.filter(shown),
    ...relay.filter(({ id }) => !device.has(id)),
  ];
}
