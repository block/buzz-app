import { UploadError, type UploadCode } from "./attachments.ts";
import { FETCH_FAILURES, isTransientFailure, ReadError } from "./errors.ts";
import { ApiCapacity, ApiPaused } from "./http-admission.ts";
import { PublishNotSent, PublishRejected } from "./outbox.ts";

/** What a failure means for the person who saw it, independent of which host,
 * transport or library produced it. */
export type FailureKind =
  /** The network, the relay or the host was unreachable or answered 5xx. */
  | "connection"
  /** The request ran out of time. */
  | "timeout"
  /** Buzz or the relay asked to wait: a paused or full request queue, 429. */
  | "busy"
  /** The request was cancelled before it finished. */
  | "cancelled"
  /** The community refused this account or action. */
  | "refused"
  /** The answer, or the request this client sent, couldn't be used: a 4xx
   * other than 401/403/408/429, or a malformed reply. The same request fails
   * again. */
  | "unusable"
  | "unknown";

export type UserCopy = Readonly<{
  /** Plain-language copy. Never an exception name, HTTP status, URL or raw
   * native/relay string. */
  text: string;
  /** Whether repeating the same action unchanged can succeed. */
  retry: boolean;
  kind: FailureKind;
  /** The raw failure text, for diagnostics only; never shown as the copy. */
  details?: string;
}>;

/** Messages the local relay broker writes for its own capacity limits
 * (`http-admission.ts`). */
const BROKER_BUSY = new Set([
  "Query concurrency limit",
  "Live stream capacity reached",
]);
/** NIP-01 machine-readable prefixes (`transport.ts` NIP01_PREFIX). */
const NIP01_PREFIX =
  /^(invalid|blocked|restricted|error|pow|duplicate|rate-limited|conflict|auth-required|mute):\s*/;
/** Upload codes that the same file can't get past by retrying unchanged. */
const UPLOAD_FINAL: ReadonlySet<UploadCode> = new Set<UploadCode>([
  "unavailable",
  "size",
  "ffmpeg",
  "metadata",
  "resolution",
  "duration",
  "codec",
  "rejected",
  "denied",
]);

const UPLOAD_KIND: Partial<Record<UploadCode, FailureKind>> = {
  capacity: "busy",
  cancelled: "cancelled",
  failed: "connection",
  invalid: "unusable",
  io: "unknown",
  image: "unknown",
  video: "unknown",
};

const SECOND_SENTENCE: Record<FailureKind, string> = {
  connection: "Check your connection, then try again.",
  timeout: "It took too long. Try again.",
  /** Depends on the wait hint: `busyCopy`. */
  busy: "",
  cancelled: "",
  refused: "",
  unusable: "",
  unknown: "",
};

/** One plain-language mapping for any rejection value. `context` is the
 * site's own sentence, such as "Couldn’t load messages.", and is the whole
 * text whenever nothing more specific is known. */
export function userCopy(error: unknown, context: string): UserCopy {
  const details = rawText(error);
  const base = { ...(details ? { details } : {}) };
  if (error instanceof UploadError)
    // Upload copy is already written for people (attachments.ts).
    return {
      ...base,
      text: error.message,
      retry: !UPLOAD_FINAL.has(error.code),
      kind: UPLOAD_KIND[error.code] ?? "refused",
    };
  const kind = failureKind(error);
  if (kind === "refused") {
    const reason = refusalReason(error);
    return {
      ...base,
      text: reason ? `${context} ${reason}` : context,
      retry: false,
      kind,
    };
  }
  const next = kind === "busy" ? busyCopy(error) : SECOND_SENTENCE[kind];
  return {
    ...base,
    text: next ? `${context} ${next}` : context,
    retry: kind !== "unusable",
    kind,
  };
}

/** `apiFailure` adds a second to a relay's own quota hint, so the lane reopens
 * just after the relay's wait. A 60s hint arrives as 61s. */
const HINT_PAD_MS = 1000;

/** A wait hint of a minute or less reads as "a few seconds"; a longer one is
 * named to the nearest minute or hour, so a long admission pause never
 * promises seconds. */
function busyCopy(error: unknown) {
  const wait =
    error instanceof ReadError
      ? error.retryAfterMs
      : error instanceof PublishNotSent
        ? error.wait?.retryAfterMs
        : undefined;
  if (
    wait === undefined ||
    !Number.isFinite(wait) ||
    wait <= 60_000 + HINT_PAD_MS
  )
    return "Buzz is busy. Try again in a few seconds.";
  const minutes = Math.round(wait / 60_000);
  if (minutes < 60)
    return `Buzz is busy. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  const hours = Math.round(minutes / 60);
  return `Buzz is busy. Try again in about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

/** Classifies a rejection by the typed errors and known native strings Buzz
 * already produces. Anything else is `unknown`, never parsed from its text. */
export function failureKind(error: unknown): FailureKind {
  if (error instanceof ApiPaused || error instanceof ApiCapacity) return "busy";
  if (error instanceof ReadError) {
    if (error.kind === "cancelled") return "cancelled";
    if (error.kind === "denied") return "refused";
    if (error.kind === "invalid-response") return "unusable";
    if (BROKER_BUSY.has(error.message)) return "busy";
    const status = error.status;
    if (status === 429) return "busy";
    // Only a `denied` read is a refusal. An `unavailable` 401/403 is an edge
    // proxy's page in front of the relay, which clears on its own.
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 401 &&
      status !== 403 &&
      status !== 408
    )
      return "unusable";
    return "connection";
  }
  if (error instanceof PublishNotSent)
    return error.wait ||
      relayPrefix(error.reason ?? error.message) === "rate-limited"
      ? "busy"
      : "connection";
  if (error instanceof PublishRejected) {
    const prefix = relayPrefix(error.reason ?? error.message);
    return prefix === "rate-limited" ? "busy" : "refused";
  }
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "NotAllowedError")
    return "refused";
  if (error instanceof Error && error.name === "NetworkError")
    return "connection";
  if (error instanceof TypeError) {
    if (FETCH_FAILURES.has(error.message)) return "connection";
  } else if (typeof error === "string" || error instanceof Error) {
    const text = typeof error === "string" ? error : error.message;
    if (BROKER_BUSY.has(text)) return "busy";
    if (isTransientFailure(error)) return "connection";
  }
  // A wrapper that only adds context keeps its cause.
  if (error instanceof Error && error.cause !== undefined)
    return failureKind(error.cause);
  return "unknown";
}

/** The raw text of a rejection, for diagnostics. */
export function rawText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error || undefined;
  if (error instanceof Error) {
    const reason = error instanceof PublishRejected ? error.reason : undefined;
    const own = String(error);
    return reason && !own.includes(reason) ? `${own} (${reason})` : own;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function relayPrefix(text: string | undefined) {
  return text ? NIP01_PREFIX.exec(text)?.[1] : undefined;
}

/** Known community refusals, written for people. A refusal Buzz doesn't
 * recognize adds nothing, so only the site's sentence is shown. */
export function refusalReason(error: unknown): string | undefined {
  const raw =
    error instanceof PublishRejected
      ? (error.reason ?? error.message)
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : undefined;
  const text = raw?.trim();
  if (!text) return undefined;
  const timedOut = /\btimed out until (\d{9,11})\b/i.exec(text);
  if (timedOut) {
    const until = formatUntil(Number(timedOut[1]));
    return until ? `You’re timed out until ${until}.` : "You’re timed out.";
  }
  if (/\bnot allowed to add members\b/i.test(text))
    return "You don’t have permission to add people to this channel.";
  if (/\bnot allowed to remove members\b/i.test(text))
    return "You don’t have permission to remove people from this channel.";
  if (/\bchannel is archived\b/i.test(text)) return "This channel is archived.";
  if (/\bnot a channel member\b|\bchannel access revoked\b/i.test(text))
    return "You’re not a member of this channel.";
  if (/\bnot a relay member\b/i.test(text))
    return "You’re not a member of this community.";
  if (/^auth-required:/i.test(text) || /\bevidence rejected\b/i.test(text))
    return "Sign in again to continue.";
  if (
    /^(blocked|restricted):/i.test(text) ||
    /\bauthorization denied\b/.test(text)
  )
    return "You don’t have permission to do this.";
  if (/^mute:/i.test(text)) return "You’re muted in this community.";
  return undefined;
}

function formatUntil(unixSeconds: number) {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}
