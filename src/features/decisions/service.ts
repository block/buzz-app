// Typed decisions for app code and plugins. A caller asks yes/no, choice or
// score questions about a piece of text; the provider this device chose in
// Settings for the text's community answers them in one call. Providers are
// plugins: each registers with `ctx.decisions.registerProvider`. The host owns
// the choice, the request limits, the deadline and the answer checks, so every
// provider is held to the same rules and returns the same checked answers.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";

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
  /** The text to judge. The provider sees it, so send only what it needs. */
  state: string;
  /** 1 to 32 questions keyed by answer name (at most 64 characters). */
  questions: Readonly<Record<string, DecisionQuestion>>;
  /** How long to wait, 1 to 30 seconds. Defaults to 30. */
  timeoutMs?: number;
  /** The Buzz community (its relay URL) the text comes from. A provider
   * that bills the community, such as Builderlab, refuses a request
   * without one. */
  community?: string;
}>;

export type DecisionAnswer =
  | Readonly<{ type: "yes_no"; probability: number }>
  | Readonly<{
      type: "choice";
      choice: string;
      confidence: number;
      /** Option value -> probability, where the provider reports them. */
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
 * - `unavailable`: no decision provider is registered.
 * - `missing_credentials`: the provider has no saved key or sign-in.
 * - `unauthorized`: the provider refused the key or sign-in.
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
const FAILURES: readonly DecisionFailure[] = [
  "unavailable",
  "missing_credentials",
  "unauthorized",
  "invalid_request",
  "input_limit",
  "timeout",
  "service_error",
  "invalid_response",
];

export type DecisionResult =
  | Readonly<{
      outcome: "answered";
      /** The key of the provider that answered. */
      backend: string;
      model: string;
      /** One answer per question, of the question's type. */
      answers: Readonly<Record<string, DecisionAnswer>>;
    }>
  | Readonly<{
      outcome: "failed";
      /** The provider that was asked; undefined when none is registered. */
      backend: string | undefined;
      reason: DecisionFailure;
    }>;

/** What a provider's `decide` resolves with. The host checks it. */
export type DecisionReply =
  | Readonly<{
      outcome: "answered";
      model: string;
      answers: Readonly<Record<string, DecisionAnswer>>;
    }>
  | Readonly<{ outcome: "failed"; reason: DecisionFailure }>;

/**
 * - `checking`: not known yet, for example while a saved key is read.
 *   Callers that need an answer wait.
 * - `ready`: it can answer.
 * - `unconfirmed`: it may be able to answer, but could not check, for
 *   example when the keychain is locked.
 * - `needs-setup`: it cannot answer until the user sets it up in Settings,
 *   or, for a community, cannot answer there.
 */
export type DecisionProviderStatus =
  | "checking"
  | "ready"
  | "unconfirmed"
  | "needs-setup";

/** A decision provider, as a plugin registers it. */
export type DecisionProvider = Readonly<{
  /** Unique within the plugin. */
  id: string;
  /** The name Settings shows, such as "TypeSafe". */
  label: string;
  /** One line about what it uses, such as "Use your own API key." */
  description: string;
  /** Whether it can answer requests from `community` (a relay URL), or
   * without one, anywhere. A provider whose setup does not depend on the
   * community ignores it. */
  status(community?: string): DecisionProviderStatus;
  subscribe(listener: () => void): () => void;
  /** Answers the request. The request is already checked against the
   * limits, and its `timeoutMs` is set. The host stops waiting at the
   * deadline and aborts `signal`. */
  decide(
    request: DecisionRequest & { timeoutMs: number },
    options: { signal: AbortSignal },
  ): Promise<DecisionReply>;
  /** Whether the user can choose and set it up for `community` (a relay
   * URL). Defaults to true. */
  offered?(community: string): boolean;
  /** Which setup `community` uses, such as an account. Communities with the
   * same scope share one setup; without one, every community shares it. */
  setupScope?(community: string): string | undefined;
  /** Its settings, shown in Settings > Decisions API for `community`, or
   * without one, for every community. */
  Settings?: ComponentType<{
    active(): boolean;
    grouped?: boolean;
    community?: string;
  }>;
  /** Ignored: Settings always names the provider above its settings. */
  showSettingsHeading?: boolean;
  /** Lower comes first in Settings. Default 0. */
  order?: number;
}>;

/** What plugins get as `ctx.decisions`. `decide` never rejects. */
export interface Decisions {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  /** The key of the provider that answers this device's decisions from
   * `community` (a relay URL), or undefined when none is registered. The
   * user chooses it for each community in Settings. */
  backend(community?: string): string | undefined;
  /** That provider's status there, or `unavailable` when there is none. */
  status(community?: string): DecisionProviderStatus | "unavailable";
  subscribe(listener: () => void): () => void;
  /** Offers a provider while the calling plugin runs, or until the returned
   * function removes it. `Decisions` exposes no way to choose the provider;
   * the user does in Settings. */
  registerProvider(provider: DecisionProvider): () => void;
  /** Clears a saved choice for a retired provider owned by this plugin.
   * The host then uses its default providers. Other choices stay in effect. */
  retireProvider(id: string): void;
}
/** Provided while decisions can be answered on this device, and withdrawn
 * while they can't: while the provider decisions go to (`backend`) is
 * registered and not `needs-setup`. One still `checking` a sign-in or key, or
 * `unconfirmed`, counts, so a flaky sign-in doesn't flap it. Read it as
 * "worth asking", not as "a provider is registered": a decision can still
 * fail while it is present. */
export type DecisionsAnswerable = Readonly<{ version: 1 }>;
const ANSWERABLE: DecisionsAnswerable = Object.freeze({ version: 1 });

declare module "@deepseek-ai/cordis" {
  interface Context {
    decisions: Decisions;
    /** Optional: a plugin that only works with decisions registers its
     * contributions inside `ctx.inject(["decisionsAnswerable"], …)`, so they
     * come and go with it. Never in a module's top-level `inject`, where a
     * device without a provider would fail its startup. */
    decisionsAnswerable?: DecisionsAnswerable;
  }
}

export type RegisteredProvider = Contribution<DecisionProvider>;

/** The choice for every community without its own. Settings no longer
 * writes it; a choice saved before per-community choices still applies. */
export const DECISION_BACKEND_KEY = "buzz-decision-backend.v1";
/** Each community's choice: a JSON object of community host -> provider. */
export const COMMUNITY_DECISION_BACKENDS_KEY =
  "buzz-decision-backend-by-community.v1";
const MAX_QUESTIONS = 32;
const NAME_LIMIT = 64;
const INPUT_LIMIT = 128 * 1024;
/** The longest a decision may take. */
export const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;

const orderOf = (provider: DecisionProvider) =>
  Number.isFinite(provider.order) ? (provider.order as number) : 0;
const byOrder = (a: RegisteredProvider, b: RegisteredProvider) =>
  orderOf(a) - orderOf(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** A provider's status, in `community` when given; one that throws is
 * unconfirmed. Host code reads provider status only through this. */
export const statusOf = (
  provider: DecisionProvider,
  community?: string,
): DecisionProviderStatus => {
  try {
    return community === undefined
      ? provider.status()
      : provider.status(community);
  } catch {
    return "unconfirmed";
  }
};

/** The key a community's choice is saved under: its relay host, so its
 * wss:// and https:// URLs share one choice. */
export const communityKey = (community: string | undefined) => {
  if (community === undefined) return undefined;
  try {
    return new URL(community).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

/** The provider that answers when no other default is registered. */
export const DEFAULT_DECISION_PROVIDER = "buzz.typesafe/typesafe";
/** Bundled providers that answer, in this order, while the user has not
 * chosen one or their choice is not registered. The first that can answer
 * does; see `DecisionsService.route`. */
export const DEFAULT_DECISION_PROVIDERS: readonly string[] = [
  "block.builderlab/builderlab",
  DEFAULT_DECISION_PROVIDER,
];

/** Each request is routed in its community: answers come from the provider
 * the user chose for that community, or the first registered default that
 * can answer there until they choose. A provider such as Builderlab answers
 * only where the community offers it; where a chosen default cannot answer,
 * the user's own TypeSafe key does. Decision text can include private
 * messages, so no other provider gets it without that choice: while a chosen
 * provider that is not a default is not registered, decisions there are
 * unavailable rather than sent somewhere else. */
export class DecisionsService extends Service implements Decisions {
  private readonly registry;
  /** The choice for communities without their own; undefined until made. */
  private chosen: string | undefined;
  /** Each community's choice, by `communityKey`. */
  private byCommunity = new Map<string, string>();
  private sorted: readonly RegisteredProvider[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(
    ctx: Context,
    private readonly storage: Storage | undefined = typeof window ===
    "undefined"
      ? undefined
      : window.localStorage,
    private readonly setTimer: (run: () => void, ms: number) => () => void = (
      run,
      ms,
    ) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  ) {
    super(ctx, "decisions");
    this.registry = createContributions<DecisionProvider>(ctx);
    try {
      this.chosen = storage?.getItem(DECISION_BACKEND_KEY) ?? undefined;
    } catch {
      // Unreadable storage means no choice.
    }
    try {
      const saved: unknown = JSON.parse(
        storage?.getItem(COMMUNITY_DECISION_BACKENDS_KEY) ?? "{}",
      );
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        for (const [community, key] of Object.entries(saved))
          if (typeof key === "string" && key)
            this.byCommunity.set(community, key);
    } catch {
      // Unreadable or malformed storage means no choices.
    }
    let stops: (() => void)[] = [];
    let withdraw: (() => void) | undefined;
    let live = false;
    // Follows every change `notify` reports: providers, their status and
    // the user's choice.
    const answerable = () => {
      const route = live ? this.route() : undefined;
      const can = !!route && route.status !== "needs-setup";
      if (can && !withdraw)
        withdraw = ctx.provide("decisionsAnswerable", ANSWERABLE);
      else if (!can && withdraw) {
        withdraw();
        withdraw = undefined;
      }
    };
    this.listeners.add(answerable);
    const watch = () => {
      for (const stop of stops) stop();
      this.sorted = Object.freeze([...this.registry.snapshot()].sort(byOrder));
      stops = this.sorted.map((provider) => {
        try {
          return provider.subscribe(() => this.notify());
        } catch {
          return () => {};
        }
      });
      this.notify();
    };
    ctx.effect(() => {
      live = true;
      const stop = this.registry.subscribe(watch);
      watch();
      return () => {
        live = false;
        stop();
        for (const each of stops) each();
        stops = [];
        answerable();
      };
    });
  }
  registerProvider(provider: DecisionProvider): () => void {
    // Registered under the calling plugin's scope, which `this.ctx` is when
    // a plugin calls through its injected `ctx.decisions`.
    return this.registry.register(this.ctx, provider);
  }
  retireProvider(id: string): void {
    const owner = this.ctx.pluginOwner;
    if (!owner)
      throw new Error("Only an installed plugin can retire a provider");
    if (!id || id.includes("/"))
      throw new Error("Invalid decision provider ID");
    const retired = `${owner.id}/${id}`;
    const kept = new Map(
      [...this.byCommunity].filter(([, key]) => key !== retired),
    );
    if (this.chosen !== retired && kept.size === this.byCommunity.size) return;
    // Removed from storage first: a choice that cannot be cleared stays.
    if (this.chosen === retired) {
      this.storage?.removeItem(DECISION_BACKEND_KEY);
      this.chosen = undefined;
    }
    if (kept.size !== this.byCommunity.size) {
      this.saveCommunities(kept);
      this.byCommunity = kept;
    }
    this.notify();
  }
  private saveCommunities(choices: ReadonlyMap<string, string>) {
    this.storage?.setItem(
      COMMUNITY_DECISION_BACKENDS_KEY,
      JSON.stringify(Object.fromEntries(choices)),
    );
  }
  /** Host-only: every registered provider, in Settings order. */
  providers = (): readonly RegisteredProvider[] => this.sorted;
  /** The provider that answers in `community` now, and its status. The
   * community's registered choice does, except that a chosen default that
   * cannot answer there leaves it to TypeSafe, the user's own key. Without
   * a registered choice, the first default that can answer does; otherwise TypeSafe,
   * whose setup the user can do, `checking` while another default is still
   * finding out whether it can answer. */
  private route(community?: string):
    | Readonly<{
        provider: RegisteredProvider;
        status: DecisionProviderStatus;
      }>
    | undefined {
    const find = (key: string) =>
      this.sorted.find((provider) => provider.key === key);
    const key = this.chosenIn(community);
    const chosen = key === undefined ? undefined : find(key);
    if (chosen) {
      const status = statusOf(chosen, community);
      const own =
        status === "needs-setup" &&
        chosen.key !== DEFAULT_DECISION_PROVIDER &&
        DEFAULT_DECISION_PROVIDERS.includes(chosen.key)
          ? find(DEFAULT_DECISION_PROVIDER)
          : undefined;
      return own
        ? { provider: own, status: statusOf(own, community) }
        : { provider: chosen, status };
    }
    if (key !== undefined && !DEFAULT_DECISION_PROVIDERS.includes(key))
      return undefined;
    const defaults = DEFAULT_DECISION_PROVIDERS.flatMap((key) => {
      const provider = find(key);
      return provider
        ? [{ provider, status: statusOf(provider, community) }]
        : [];
    });
    const answering = defaults.find(
      ({ status }) => status === "ready" || status === "unconfirmed",
    );
    if (answering) return answering;
    const fallback =
      defaults.find(
        ({ provider }) => provider.key === DEFAULT_DECISION_PROVIDER,
      ) ?? defaults[0];
    if (!fallback) return undefined;
    return defaults.some(({ status }) => status === "checking")
      ? { provider: fallback.provider, status: "checking" }
      : fallback;
  }
  private current(community?: string): RegisteredProvider | undefined {
    return this.route(community)?.provider;
  }
  /** Resolves once the provider routed in `community` is not `checking`, or
   * on `signal`. */
  private known(signal: AbortSignal, community?: string): Promise<void> {
    return new Promise((resolve) => {
      const settle = () => {
        if (!signal.aborted && this.status(community) === "checking") return;
        stop();
        signal.removeEventListener("abort", settle);
        resolve();
      };
      const stop = this.subscribe(settle);
      signal.addEventListener("abort", settle, { once: true });
      settle();
    });
  }
  // Bound, so a caller can pass these on, as React's external stores do.
  backend = (community?: string): string | undefined =>
    this.current(community)?.key;
  status = (community?: string): DecisionProviderStatus | "unavailable" =>
    this.route(community)?.status ?? "unavailable";
  /** Host-only: the provider the user chose for `community`, or for every
   * community without its own choice, whether or not it is registered. */
  chosenIn = (community?: string): string | undefined => {
    const key = communityKey(community);
    return (
      (key === undefined ? undefined : this.byCommunity.get(key)) ?? this.chosen
    );
  };
  /** Host-only: Settings chooses the provider for `community`, or without
   * one, for every community without its own choice. Not part of
   * `Decisions`. */
  setBackend(key: string, community?: string): void {
    if (!this.sorted.some((provider) => provider.key === key)) return;
    const before = this.chosenIn(community);
    const host = communityKey(community);
    if (community !== undefined && host === undefined) return;
    try {
      if (host === undefined) this.storage?.setItem(DECISION_BACKEND_KEY, key);
      else this.saveCommunities(new Map(this.byCommunity).set(host, key));
    } catch {
      // Still in effect for this session.
    }
    if (host === undefined) this.chosen = key;
    else this.byCommunity.set(host, key);
    if (before !== key) this.notify();
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const { community } = request;
    let provider = this.current(community);
    let backend = provider?.key;
    const failed = (reason: DecisionFailure): DecisionResult =>
      Object.freeze({ outcome: "failed", backend, reason });
    if (!provider) return failed("unavailable");
    const invalid = checkRequest(request);
    if (invalid) return failed(invalid);
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(
        MIN_TIMEOUT_MS,
        Number.isFinite(request.timeoutMs)
          ? (request.timeoutMs as number)
          : MAX_TIMEOUT_MS,
      ),
    );
    const abort = new AbortController();
    let stopTimer = () => {};
    const deadline = new Promise<"timeout">((resolve) => {
      stopTimer = this.setTimer(() => resolve("timeout"), timeoutMs);
    });
    let reply: unknown;
    try {
      reply = await Promise.race([
        // A provider still checking its setup may stop answering, or a
        // default may start to: route once it knows, within the deadline.
        this.known(abort.signal, community).then(
          (): DecisionReply | Promise<DecisionReply> => {
            // Past the deadline: never send the request anywhere.
            if (abort.signal.aborted)
              return { outcome: "failed", reason: "timeout" };
            provider = this.current(community);
            backend = provider?.key;
            if (!provider) return { outcome: "failed", reason: "unavailable" };
            return provider.decide(Object.freeze({ ...request, timeoutMs }), {
              signal: abort.signal,
            });
          },
        ),
        deadline,
      ]);
    } catch {
      return failed("service_error");
    } finally {
      stopTimer();
    }
    if (reply === "timeout") {
      abort.abort();
      return failed("timeout");
    }
    if (!reply || typeof reply !== "object") return failed("invalid_response");
    const { outcome, reason, model, answers } = reply as Record<
      string,
      unknown
    >;
    if (outcome === "failed")
      return FAILURES.includes(reason as DecisionFailure)
        ? failed(reason as DecisionFailure)
        : failed("invalid_response");
    if (outcome !== "answered" || typeof model !== "string" || !model)
      return failed("invalid_response");
    const checked = checkAnswers(request.questions, answers);
    if (!checked || backend === undefined) return failed("invalid_response");
    return Object.freeze({
      outcome: "answered",
      backend,
      model,
      answers: checked,
    });
  }
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The limits every provider accepts, or why the request breaks them. */
export function checkRequest(
  request: DecisionRequest,
): DecisionFailure | undefined {
  if (!record(request) || !text(request.state) || !record(request.questions))
    return "invalid_request";
  if (request.community !== undefined && !text(request.community))
    return "invalid_request";
  const questions = Object.entries(request.questions);
  if (questions.length === 0 || questions.length > MAX_QUESTIONS)
    return "invalid_request";
  for (const [name, question] of questions) {
    if (!text(name) || [...name].length > NAME_LIMIT) return "invalid_request";
    if (!record(question) || !text(question.instructions))
      return "invalid_request";
    const ok =
      question.type === "yes_no" ||
      (question.type === "choice" &&
        record(question.options) &&
        Object.keys(question.options).length >= 2 &&
        Object.keys(question.options).length <= 255 &&
        Object.entries(question.options).every(
          ([value, when]) => text(value) && typeof when === "string",
        )) ||
      (question.type === "score" &&
        Array.isArray(question.levels) &&
        question.levels.length >= 2 &&
        question.levels.length <= 10 &&
        question.levels.every(text));
    if (!ok) return "invalid_request";
  }
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(request)).length;
  } catch {
    return "invalid_request";
  }
  return size > INPUT_LIMIT ? "input_limit" : undefined;
}

const unit = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= 1;
/** Every key known and every value a probability; missing means none. */
function probabilities(
  value: unknown,
  known: (key: string) => boolean,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined || value === null) return Object.freeze({});
  if (!record(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, p]) => known(key) && unit(p))) return undefined;
  return Object.freeze(Object.fromEntries(entries) as Record<string, number>);
}

/** The answers, checked against the questions: every question answered with
 * its own type, a known choice, a place on the scale, values within 0–1.
 * Answers to questions not asked are dropped. */
export function checkAnswers(
  questions: DecisionRequest["questions"],
  answers: unknown,
): Readonly<Record<string, DecisionAnswer>> | undefined {
  if (!record(answers)) return undefined;
  // Collected as entries: assigning `checked["__proto__"]` on a plain object
  // would set its prototype instead of keeping the answer.
  const checked: [string, DecisionAnswer][] = [];
  for (const [name, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(answers, name) ? answers[name] : undefined;
    if (!record(answer) || answer.type !== question.type) return undefined;
    if (question.type === "yes_no") {
      if (!unit(answer.probability)) return undefined;
      checked.push([
        name,
        Object.freeze({
          type: "yes_no",
          probability: answer.probability,
        }),
      ]);
    } else if (question.type === "choice") {
      const known = (key: string) => Object.hasOwn(question.options, key);
      const p = probabilities(answer.probabilities, known);
      if (
        typeof answer.choice !== "string" ||
        !known(answer.choice) ||
        !unit(answer.confidence) ||
        !p
      )
        return undefined;
      checked.push([
        name,
        Object.freeze({
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: p,
        }),
      ]);
    } else {
      const top = question.levels.length - 1;
      const known = (key: string) =>
        /^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= top;
      const p = probabilities(answer.probabilities, known);
      if (
        typeof answer.score !== "number" ||
        !(answer.score >= 0 && answer.score <= top) ||
        !unit(answer.confidence) ||
        !p
      )
        return undefined;
      checked.push([
        name,
        Object.freeze({
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          probabilities: p,
        }),
      ]);
    }
  }
  return Object.freeze(
    Object.fromEntries(checked) as Record<string, DecisionAnswer>,
  );
}
