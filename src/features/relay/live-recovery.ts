import type { RecoveryStatus } from "./recovery";
import type { LiveSnapshot } from "./live";

/** The parts of a session's live view that recovery classifies. */
export type LiveRecoveryView = LiveSnapshot &
  Readonly<{
    roster: Readonly<{
      state: string;
      transient?: true;
      /** A denied read's ask (errors.ts deniedRead). */
      denied?: "sign-in" | "permission";
    }>;
    heads: readonly Readonly<{
      channelId?: string;
      state: string;
      transient?: true;
      denied?: "sign-in" | "permission";
    }>[];
    previews?: "checking" | "suspended";
  }>;

/** NIP-01 CLOSED prefixes that mean someone has to act: the same request
 * fails again until access, the request or the client changes. Session
 * recovery leaves them alone; the live layer retries them on its own slow
 * schedule (liveSlowRetryDelay). */
const PERMANENT_PREFIXES = [
  "restricted:",
  "blocked:",
  "invalid:",
  "auth-required:",
  "unsupported:",
  "pow:",
  "duplicate:",
];
/** Deterministic local failures (live.ts): retrying sends the same thing. */
const PERMANENT_LOCAL = new Set([
  "Unsupported live cooldown; automatic setup stopped",
]);
/** A route failure that a later attempt can clear. Anything not known to
 * need action counts: relays use other and unprefixed reasons for outages,
 * and a capped retry costs little next to a live view that never recovers. */
export function isTransientLiveError(reason: string | undefined): boolean {
  if (reason === undefined) return true;
  return (
    !PERMANENT_LOCAL.has(reason) &&
    !PERMANENT_PREFIXES.some((prefix) => reason.startsWith(prefix))
  );
}

/** How the live layer looks to session recovery. Only failures a retry can
 * fix count as failed. A sign-in error or a denial is settled here and stays
 * visible in live status instead; the live layer retries it slowly itself. */
export function liveRecoveryStatus(view: LiveRecoveryView): RecoveryStatus {
  // A terminal connection error closed the socket: its routes stay pending
  // but nothing is in flight. Finite roster and head reads still count.
  const routes = view.status === "error" ? [] : view.routes;
  // "retrying" counts as failed so wake, network and focus signals skip the
  // live layer's own backoff wait too.
  if (
    view.status === "retrying" ||
    view.previews === "suspended" ||
    view.roster.state === "deferred" ||
    (view.roster.state === "error" && view.roster.transient) ||
    view.heads.some((head) => head.state === "error" && head.transient) ||
    routes.some(
      (route) => route.status === "error" && isTransientLiveError(route.error),
    )
  )
    return "failed";
  // A retried read in flight is not proof of recovery. Reporting it as
  // settled would reset the delay and loop the retry every second.
  return view.status === "connecting" ||
    view.previews === "checking" ||
    view.roster.state === "pending" ||
    view.heads.some((head) => head.state === "pending") ||
    routes.some((route) => route.status === "pending")
    ? "busy"
    : "settled";
}

type LiveRead = Readonly<{ state: string; transient?: true }>;
/** True while session recovery retries the roster read (failed or busy in
 * liveRecoveryStatus), so recovery reports a list error. A denial is not. */
export const rosterRecovering = (roster: LiveRead) =>
  roster.state === "deferred" ||
  roster.state === "pending" ||
  (roster.state === "error" && !!roster.transient);
/** The same for one channel's timeline: true while the live source is not
 * settled for that channel. That covers its head read failing transiently or
 * in flight, and the handoff after a dropped stream: catch-up entries are
 * cleared until the channel's route re-establishes, which reads its head
 * again. */
export function headRecovering(view: LiveRecoveryView, channelId: string) {
  return (
    liveRecoveryStatus({
      status: view.status,
      routes: view.routes.filter((route) => route.channelId === channelId),
      roster: { state: "verified" },
      heads: view.heads.filter((head) => head.channelId === channelId),
    }) !== "settled"
  );
}

/** Terminal live sign-in failures (live.ts). Signing in again clears them. */
const SIGN_IN_FAILURES = new Set([
  "Live signer does not match viewer",
  "Live authentication signing failed",
  "Relay rejected live authentication",
  "Federated sign-in is required",
  "Federated identity is not configured for this community",
  "Federated relay authorization unavailable",
]);

/** What the live connection's own refusal asks of the person, while its
 * error is still the one the refusal explains (live.ts LiveSnapshot). */
export function liveDenied(
  snapshot: Pick<LiveSnapshot, "error" | "refusal">,
): "sign-in" | "permission" | undefined {
  const refusal = snapshot.refusal;
  return refusal && refusal.error === snapshot.error
    ? refusal.denied
    : undefined;
}

/** What a live failure asks of the person: access they may not have, a new
 * sign-in, or nothing in particular. "stopped" is a local failure Buzz won't
 * retry, since it would send the same thing. `denied` is a denied read's own
 * answer, whatever its text (errors.ts deniedRead). */
export function liveFailureKind(
  reason: string | undefined,
  denied?: "sign-in" | "permission",
): "permission" | "sign-in" | "stopped" | "other" {
  if (denied) return denied;
  const text = reason?.trim() ?? "";
  // A finite read refused over HTTP (errors.ts httpReadError).
  const status = /^Relay read failed \((401|403)\)$/.exec(text)?.[1];
  if (status) return status === "401" ? "sign-in" : "permission";
  if (/^(?:restricted|blocked):/.test(text)) return "permission";
  if (PERMANENT_LOCAL.has(text)) return "stopped";
  if (
    text.startsWith("auth-required:") ||
    SIGN_IN_FAILURES.has(text) ||
    // A policy close survives one reconnect with fresh sign-in evidence.
    text.startsWith("Live connection closed (1008")
  )
    return "sign-in";
  return "other";
}
