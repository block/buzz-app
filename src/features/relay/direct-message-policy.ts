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
