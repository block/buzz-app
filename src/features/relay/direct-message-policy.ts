/** The most people a DM can include, the viewer among them. Agents do not
 * count; the relay enforces this. */
export const MAX_DM_PEOPLE = 9;

/** Participant-set policy shared by the app and the existing browser broker. */
export function validDirectMessageParticipants(
  pubkeys: readonly string[],
  viewer: string,
): boolean {
  return (
    pubkeys.length >= 1 &&
    pubkeys.length <= 8 &&
    new Set(pubkeys).size === pubkeys.length &&
    pubkeys.every((key) => /^[0-9a-f]{64}$/.test(key) && key !== viewer)
  );
}

/** Whether a DM of `members` is the DM of `expected`, as the relay decides:
 * by its people when it has two or more, so agents never change which DM it
 * is; otherwise by every member. */
export function sameDirectMessage(
  members: readonly string[],
  expected: ReadonlySet<string>,
  isAgent: (pubkey: string) => boolean,
): boolean {
  const people = [...expected].filter((key) => !isAgent(key));
  const shared =
    people.length >= 2 ? members.filter((key) => !isAgent(key)) : [...members];
  const required = people.length >= 2 ? new Set(people) : expected;
  return (
    shared.length === required.size && shared.every((key) => required.has(key))
  );
}
