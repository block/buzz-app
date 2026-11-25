/**
 * TEMPORARY EXCEPTION to "a channel's first paint is final".
 *
 * With today's relay, names the directory does not hold are a second round
 * trip after the head. While this is true, a first screen paints as soon as
 * its head lands, with the names already held. The rest show their usual
 * fallback labels until the names read that the gather started answers, then
 * fill in. It is the only change after the first paint that is allowed.
 *
 * Remove it once the first-screen endpoint (the BFF) returns names with the
 * rows. Delete this file and its two imports:
 * - `first-screen.ts`: the `namesWait` choice. The gather waits for names up
 *   to `NAMES_DEADLINE_MS` again.
 * - `tests/browser/first-paint.spec.mjs`: the `lateName` exemption. The spec
 *   is strict again.
 * Setting this to false does the same without deleting anything.
 */
export const ALLOW_LATE_NAMES = true;
