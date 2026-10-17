// Typed decisions for app code and plugins. A caller asks yes/no, choice or
// score questions about a piece of text; the backend this device chose in
// Settings answers them in one call. Native code owns the endpoints,
// credentials, limits and answer checks (src-tauri/src/decisions.rs), so every
// backend returns the same checked answers or the same failure reasons.
import { Service, type Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * - `block`: Jev (TypeSafe System One) through Block's KGoose. The default; it
 *   needs a Block laptop sign-in, not a key.
 * - `block-openai`: OpenAI Decisions through Block's KGoose.
 * - `typesafe`: Jev called directly with the user's own TypeSafe key.
 */
export type DecisionBackend = "block" | "block-openai" | "typesafe";
export const DECISION_BACKENDS: readonly DecisionBackend[] = Object.freeze([
  "block",
  "block-openai",
  "typesafe",
]);
export const DEFAULT_DECISION_BACKEND: DecisionBackend = "block";

export type DecisionQuestion =
  /** Answered with the probability that the statement holds. */
  | Readonly<{ type: "yes_no"; instructions: string }>
  /** One of 2 to 255 options: value -> when to pick it. */
  | Readonly<{
      type: "choice";
      instructions: string;
      options: Readonly<Record<string, string>>;
    }>
  /** A place on a scale of 2 to 10 level labels, lowest first. */
  | Readonly<{
      type: "score";
      instructions: string;
      levels: readonly string[];
    }>;

export type DecisionRequest = Readonly<{
  /** The text to judge. The backend sees it, so send only what it needs. */
  state: string;
  /** 1 to 32 questions keyed by answer name (at most 64 characters). */
  questions: Readonly<Record<string, DecisionQuestion>>;
  /** How long to wait, 1 to 30 seconds. Defaults to 30. */
  timeoutMs?: number;
}>;

export type DecisionAnswer =
  | Readonly<{ type: "yes_no"; probability: number }>
  | Readonly<{
      type: "choice";
      choice: string;
      confidence: number;
      /** Option value -> probability, where the backend reports them. */
      probabilities: Readonly<Record<string, number>>;
    }>
  | Readonly<{
      type: "score";
      /** Where the answer falls on the 0-based scale; it can be fractional. */
      score: number;
      confidence: number;
      /** Level index ("0", "1", …) -> probability. */
      probabilities: Readonly<Record<string, number>>;
    }>;

/**
 * - `unavailable`: this build has no decision backend (the browser build).
 * - `missing_credentials`: `typesafe` is chosen and no key is saved.
 * - `unauthorized`: the key was refused, or there is no Block sign-in.
 * - `invalid_request`: the questions are malformed or were rejected.
 */
export type DecisionFailure =
  | "unavailable"
  | "missing_credentials"
  | "unauthorized"
  | "invalid_request"
  | "input_limit"
  | "timeout"
  | "service_error"
  | "invalid_response";

export type DecisionResult =
  | Readonly<{
      outcome: "answered";
      backend: DecisionBackend;
      model: string;
      /** One answer per question, of the question's type. */
      answers: Readonly<Record<string, DecisionAnswer>>;
    }>
  | Readonly<{
      outcome: "failed";
      backend: DecisionBackend;
      reason: DecisionFailure;
    }>;

/** What plugins get as `ctx.decisions`. `decide` never rejects. */
export interface Decisions {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  /** The backend that answers this device's decisions. */
  backend(): DecisionBackend;
  subscribe(listener: () => void): () => void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    decisions: Decisions;
  }
}

/** Calls native `decide`; resolves with its result. */
export type DecisionsNative = (
  backend: DecisionBackend,
  request: DecisionRequest,
) => Promise<unknown>;
export const nativeDecisions = (): DecisionsNative | undefined =>
  isTauri()
    ? (backend, request) => invoke("decide", { backend, request })
    : undefined;

export const DECISION_BACKEND_KEY = "buzz-decision-backend.v1";
const isBackend = (value: unknown): value is DecisionBackend =>
  DECISION_BACKENDS.includes(value as DecisionBackend);

export class DecisionsService extends Service implements Decisions {
  private current: DecisionBackend;
  private readonly listeners = new Set<() => void>();
  constructor(
    ctx: Context,
    private readonly native: DecisionsNative | undefined = nativeDecisions(),
    private readonly storage: Storage | undefined = typeof window ===
    "undefined"
      ? undefined
      : window.localStorage,
  ) {
    super(ctx, "decisions");
    let saved: unknown;
    try {
      saved = storage?.getItem(DECISION_BACKEND_KEY);
    } catch {
      // Unreadable storage means the default.
    }
    this.current = isBackend(saved) ? saved : DEFAULT_DECISION_BACKEND;
  }
  // Bound, so a caller can pass these on, as React's external stores do.
  backend = (): DecisionBackend => this.current;
  /** Host-only: Settings chooses the backend. Not part of `Decisions`. */
  setBackend(backend: DecisionBackend): void {
    if (!isBackend(backend) || backend === this.current) return;
    this.current = backend;
    try {
      this.storage?.setItem(DECISION_BACKEND_KEY, backend);
    } catch {
      // Still in effect for this session.
    }
    for (const listener of [...this.listeners]) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const backend = this.current;
    const failed = (reason: DecisionFailure): DecisionResult =>
      Object.freeze({ outcome: "failed", backend, reason });
    if (!this.native) return failed("unavailable");
    let reply: unknown;
    try {
      reply = await this.native(backend, request);
    } catch {
      // Native refused the arguments before any call: a malformed request.
      return failed("invalid_request");
    }
    return isResult(reply, backend) ? reply : failed("invalid_response");
  }
}

/** Native results are already checked; this guards the IPC shape only. */
function isResult(
  value: unknown,
  backend: DecisionBackend,
): value is DecisionResult {
  if (!value || typeof value !== "object") return false;
  const reply = value as Record<string, unknown>;
  if (reply.backend !== backend) return false;
  if (reply.outcome === "failed") return typeof reply.reason === "string";
  return (
    reply.outcome === "answered" &&
    typeof reply.model === "string" &&
    !!reply.answers &&
    typeof reply.answers === "object"
  );
}
