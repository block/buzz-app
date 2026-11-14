import { formatItemTimestamp } from "../../shared/datetime";
import { errorMessage } from "../../shared/error-message";

/** A NIP-01 machine-readable prefix, after the "Retry blocked:" or "Retry
 * failed:" the outbox puts on a repeated attempt. */
const PREFIX =
  /^(?:Retry (?:blocked|failed): )?(restricted|blocked|auth-required|rate-limited|invalid|pow|duplicate|conflict|unsupported|error):\s*/;
/** The relay's refusal of a timed-out member's write, with or without the
 * prefix a transport strips for display. */
const TIMEOUT =
  /^(?:Retry (?:blocked|failed): )?(?:restricted:\s*)?you are timed out until (\d{1,12})$/i;

/** An HTTP refusal whose body had no NIP-01 reason (transport.ts). */
const HTTP =
  /^(?:Retry (?:blocked|failed): )?Relay rejected the message \((\d{3})\)$/;

/** A refusal's text, or an outbox item that keeps the relay's own words in
 * `reason` beside the summary in `error`. */
export type Refusal =
  | string
  | Readonly<{ error?: string | undefined; reason?: string | undefined }>
  | undefined;

/** The text to read: an item's own relay words when they carry a refusal
 * (an HTTP summary drops the NIP-01 prefix), otherwise its summary. */
function refusalText(value: Refusal): string | undefined {
  if (typeof value !== "object") return value;
  const raw = value.reason?.trim();
  return raw && (kindOf(raw) || TIMEOUT.test(raw)) ? raw : value.error;
}

export type RefusalKind =
  | "permission"
  | "sign-in"
  | "busy"
  | "duplicate"
  | "conflict"
  | "invalid"
  | "error";

/** What a relay's refusal means, from its NIP-01 prefix or the HTTP status
 * the transport reports without one. Undefined for other text. */
export function refusalKind(reason: Refusal): RefusalKind | undefined {
  return kindOf(refusalText(reason));
}

function kindOf(reason: string | undefined): RefusalKind | undefined {
  const status = HTTP.exec(reason?.trim() ?? "")?.[1];
  if (status)
    return status === "401"
      ? "sign-in"
      : status === "403"
        ? "permission"
        : status === "429"
          ? "busy"
          : status === "409"
            ? "conflict"
            : "invalid";
  switch (PREFIX.exec(reason?.trim() ?? "")?.[1]) {
    case undefined:
      return undefined;
    case "restricted":
    case "blocked":
      return "permission";
    case "auth-required":
      return "sign-in";
    case "rate-limited":
      return "busy";
    case "duplicate":
      return "duplicate";
    case "conflict":
      return "conflict";
    case "error":
      return "error";
    default:
      return "invalid";
  }
}

const REASONS: Record<RefusalKind, string> = {
  permission: "you don’t have permission",
  "sign-in": "you need to sign in again",
  busy: "the community asked Buzz to slow down",
  duplicate: "it was already sent",
  conflict: "it changed somewhere else",
  invalid: "the community can’t accept it",
  error: "the community had a problem",
};

/** A relay's refusal in plain words, as a clause that can follow "Not sent:",
 * or undefined when `reason` is not a relay refusal. The relay's own words
 * belong in Diagnostics, never in this text. */
export function refusalReason(value: Refusal): string | undefined {
  const reason = refusalText(value);
  const until = TIMEOUT.exec(reason?.trim() ?? "")?.[1];
  if (until)
    return `you’re timed out until ${formatItemTimestamp(Number(until), { withTime: true })}`;
  const kind = kindOf(reason);
  return kind && REASONS[kind];
}

/** Whether sending a failed outbox item again can succeed. Not after a
 * refusal, unless it asked for a new sign-in, a wait, or the community had
 * its own problem; nor after a check on this device that fails the same way
 * again (outbox.ts PublishBlocked). */
export function retryable(
  item: Readonly<{
    refused?: true | undefined;
    unsent?: string | undefined;
    error?: string | undefined;
    reason?: string | undefined;
  }>,
): boolean {
  if (item.unsent === "blocked") return false;
  if (!item.refused) return true;
  const kind = refusalKind(item);
  return kind === "sign-in" || kind === "busy" || kind === "error";
}

/** Why a failed outbox item wasn't sent, as a sentence: the plain
 * sentence a check on this device wrote (outbox.ts PublishBlocked), or a
 * refusal in plain words. Undefined when Buzz can't say. */
export function unsentSentence(
  item: Readonly<{
    refused?: true | undefined;
    unsent?: string | undefined;
    error?: string | undefined;
    reason?: string | undefined;
  }>,
): string | undefined {
  if (item.unsent === "blocked") return item.error;
  return item.refused ? refusalSentence(item) : undefined;
}

/** `refusalReason` as a sentence of its own. */
export function refusalSentence(reason: Refusal): string | undefined {
  const clause = refusalReason(reason);
  return clause && `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/** A failure to show someone: a relay refusal in plain words, otherwise the
 * thrown value's own message (never "Error: …"). */
export function failureText(error: unknown, fallback?: string): string {
  const message = errorMessage(error, fallback);
  // A transport's refusal keeps the relay's own words beside its summary.
  const reason =
    error instanceof Error &&
    "reason" in error &&
    typeof error.reason === "string"
      ? error.reason
      : undefined;
  return refusalSentence({ error: message, reason }) ?? message;
}

/** A failure whose message already names who or what it is about, so a list
 * of failures shows it as written rather than after a name. `final` as for
 * FinalFailure. */
export class NamedError extends Error {
  readonly final: boolean;
  constructor(message: string, options?: { final?: boolean }) {
    super(message);
    this.final = options?.final ?? false;
  }
}

/** A failure that sending again would meet the same way, as retryable()
 * decides for an outbox item, so nothing offers Retry for it. */
export class FinalFailure extends Error {}

/** Whether Retry has nothing to offer for this failure. */
export const failsAgain = (error: unknown) =>
  error instanceof FinalFailure || (error instanceof NamedError && error.final);
