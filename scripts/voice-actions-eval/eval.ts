// Runs the voice-actions cases against the real decision service and scores
// them. The request is the builder's, sent as native `decisions.rs` sends a
// TypeSafe call (System One, Jev pinned), and the answers pass the host's own
// checks (`checkAnswers`), so a case sees what the app would.
import {
  checkAnswers,
  checkRequest,
  type DecisionAnswer,
  type DecisionRequest,
} from "../../src/features/decisions/service";
import {
  ACTIONS,
  CONFIRM,
  ENTITIES,
  PLACES,
  UNOFFERED,
  hover,
} from "./catalog";
import { PEOPLE } from "./world";
import { CASES, type Case, type Category, type Expected } from "./cases";
import { FINAL, HERE } from "./cases-final";
import { REALSTT } from "./cases-realstt";
import { HELDOUT, HELDOUT2, HELDOUT3 } from "./cases-heldout";
import {
  buildActionDecision,
  type ResolvedAction,
} from "../../src/features/search/voice-actions";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** `jev::MODEL` in src-tauri/src/jev.rs. */
const MODEL = "jev-1.13.0";
/** The app acts at or above this, as voice jump does. */
export const THRESHOLD = 0.5;

type Decide = (request: DecisionRequest) => Promise<{
  model: string;
  answers: Readonly<Record<string, DecisionAnswer>>;
  ms: number;
}>;

/** One TypeSafe call, encoded and decoded as `decisions.rs` does. */
export const ALL_CASES: readonly Case[] = [
  ...CASES,
  ...HELDOUT,
  ...HELDOUT2,
  ...HELDOUT3,
  ...FINAL,
  ...HERE,
  ...REALSTT,
];

export const typesafe =
  (key: string): Decide =>
  async (request) => {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([name, q]) => [
        name,
        q.type === "yes_no"
          ? { type: "noul", instructions: q.instructions }
          : q.type === "choice"
            ? {
                type: "choice",
                instructions: q.instructions,
                criteria: q.options,
              }
            : {
                type: "score",
                instructions: q.instructions,
                criteria: q.levels,
              },
      ]),
    );
    const start = performance.now();
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ state: request.state, model: MODEL, questions }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    });
    const body = (await response.json()) as {
      model?: string;
      answers?: Record<string, Record<string, unknown>>;
    };
    const ms = performance.now() - start;
    if (!response.ok)
      throw new Error(`TypeSafe ${response.status}: ${JSON.stringify(body)}`);
    if (body.model !== MODEL) throw new Error(`Unexpected model ${body.model}`);
    // TypeSafe's typed body sits beside its `type`; probabilities may come
    // as a list of {value, probability}.
    const raw = Object.fromEntries(
      Object.entries(body.answers ?? {}).map(([name, a]) => {
        if (a.type === "noul")
          return [name, { type: "yes_no", probability: a.noul }];
        const list = a.probabilities;
        const probabilities = Array.isArray(list)
          ? Object.fromEntries(
              list.map(
                (e: {
                  value?: unknown;
                  level?: unknown;
                  probability: number;
                }) => [String(e.value ?? e.level), e.probability],
              ),
            )
          : list;
        return [name, { ...a, probabilities }];
      }),
    );
    const answers = checkAnswers(request.questions, raw);
    if (!answers)
      throw new Error(
        `Answers failed the host's checks: ${JSON.stringify(body)}`,
      );
    return { model: body.model, answers, ms };
  };

/** Messaging someone opens the DM or agent chat, as jumping to it does. */
const DM_PLACE = new Map(
  PEOPLE.filter((p) => p.dm).map((p) => [
    p.id,
    `${p.agent ? "chat" : "dm"}:d-${p.name}`,
  ]),
);

type ScoredOutcome =
  | {
      kind: "action";
      actionId: string;
      owner?: string | undefined;
      target?: string | undefined;
      text?: string | undefined;
      probability: number;
    }
  | { kind: "navigate"; place: string; probability: number }
  | { kind: "none"; probability: number };

/** A move into Starred is starring, as the sidebar's own menu does it.
 * Messaging someone with a DM open is going to that DM. */
function normalize(got: ResolvedAction): ScoredOutcome {
  if (got.kind === "none") return { kind: "none", probability: 0 };
  if (got.kind === "navigate") {
    return {
      kind: "navigate",
      place: got.place.key,
      probability: got.probability,
    };
  }
  const ownerId = got.owner?.id;
  const targetId = got.target?.id;
  if (got.actionId.startsWith("person.dm")) {
    const place = DM_PLACE.get(ownerId ?? targetId ?? "");
    if (place) return { kind: "navigate", place, probability: got.probability };
  }
  if (got.actionId === "channel.move_to_section" && targetId === "s-Starred") {
    return {
      kind: "action",
      actionId: "channel.star",
      ...(ownerId ? { owner: ownerId } : {}),
      probability: got.probability,
    };
  }
  return {
    kind: "action",
    actionId: got.actionId,
    ...(ownerId ? { owner: ownerId } : {}),
    ...(targetId ? { target: targetId } : {}),
    ...(got.text !== undefined ? { text: got.text } : {}),
    probability: got.probability,
  };
}

const same = (a?: string, b?: string) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export function score(expect: Expected, got: ScoredOutcome) {
  const acted = got.kind !== "none" && got.probability >= THRESHOLD;
  if ("none" in expect) {
    const correct = !acted;
    return { correct, intentCorrect: correct, acted };
  }
  if ("navigate" in expect) {
    const intentCorrect = got.kind === "navigate";
    return {
      correct: intentCorrect && got.place === expect.navigate,
      intentCorrect,
      acted,
    };
  }
  const intentCorrect = got.kind === "action" && got.actionId === expect.action;
  const correct =
    intentCorrect &&
    got.kind === "action" &&
    same(got.owner, expect.owner) &&
    same(got.target, expect.target) &&
    same(got.text, expect.text);
  return { correct, intentCorrect, acted };
}

const describe = (got: ScoredOutcome) =>
  got.kind === "action"
    ? `${got.actionId}(${[got.owner, got.target, got.text && JSON.stringify(got.text)].filter(Boolean).join(", ")})`
    : got.kind === "navigate"
      ? `navigate(${got.place})`
      : "none";
const describeExpected = (e: Expected) =>
  "none" in e
    ? "none"
    : "navigate" in e
      ? `navigate(${e.navigate})`
      : `${e.action}(${[e.owner, e.target, e.text && JSON.stringify(e.text)].filter(Boolean).join(", ")})`;

export type CaseResult = Readonly<{
  id: string;
  category: Category;
  hover: string | null;
  spoken: string;
  expected: string;
  got: string;
  probability: number;
  correct: boolean;
  intentCorrect: boolean;
  /** Acted at the threshold on a wrong answer. */
  misfire: boolean;
  /** A misfire on an action that asks first. */
  misfireConfirmed: boolean;
  ms: number;
  questions: number;
  actionOptions: number;
  requestBytes: number;
  topActions: readonly (readonly [string, number])[];
  /** Every find question's pick and its probability. */
  slots: Readonly<Record<string, readonly [string, number]>>;
  /** The checked answers, so `rescore.ts` can resolve them again under
   * changed decision rules without asking Jev again. */
  answers?: Readonly<Record<string, DecisionAnswer>>;
  error?: string;
}>;

/** What a case should get from the app: no action at all when it asks for
 * one the app doesn't offer. */
const asksUnoffered = (c: Case) =>
  "action" in c.expect && UNOFFERED.has(c.expect.action);
const expectOf = (c: Case): Expected =>
  asksUnoffered(c) ? { none: true } : c.expect;

const build = (c: Case) =>
  buildActionDecision({
    spoken: c.spoken,
    hovered: hover(c.hover),
    actions: ACTIONS,
    entities: ENTITIES,
    places: PLACES,
  });

/** Scores answers Jev already gave, under the decision rules as they are
 * now: the request is rebuilt from the case, so it must be the same world
 * (`VOICE_EVAL_SCALE`) the answers came from. */
export function rescoreCase(
  c: Case,
  answers: Readonly<Record<string, DecisionAnswer>>,
) {
  const got = normalize(build(c).resolve(answers));
  const s = score(expectOf(c), got);
  const misfire = s.acted && !s.correct;
  return {
    got: describe(got),
    correct: s.correct,
    misfire,
    misfireConfirmed:
      misfire && got.kind === "action" && CONFIRM.has(got.actionId),
  };
}

export async function runCase(decide: Decide, c: Case): Promise<CaseResult> {
  const { request, resolve } = build(c);
  const base = {
    id: c.id,
    category: c.category,
    hover: c.hover,
    spoken: c.spoken,
    expected: describeExpected(expectOf(c)),
  };
  if (!request) throw new Error(`${c.id}: no request`);
  const invalid = checkRequest(request);
  if (invalid) throw new Error(`${c.id}: request ${invalid}`);
  const meta = {
    questions: Object.keys(request.questions).length,
    actionOptions:
      request.questions.action?.type === "choice"
        ? Object.keys(request.questions.action.options).length
        : 0,
    requestBytes: new TextEncoder().encode(JSON.stringify(request)).length,
  };
  try {
    const { answers, ms } = await decide(request);
    const got = normalize(resolve(answers));
    const s = score(expectOf(c), got);
    const action = answers.action;
    const topActions =
      action?.type === "choice"
        ? Object.entries(action.probabilities)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, p]) => [k, Math.round(p * 1000) / 1000] as const)
        : [];
    const slots = Object.fromEntries(
      Object.entries(answers)
        .filter(([name, a]) => name !== "action" && a.type === "choice")
        .map(([name, a]) => {
          const c = a as Extract<DecisionAnswer, { type: "choice" }>;
          const p = c.probabilities[c.choice] ?? c.confidence;
          return [name, [c.choice, Math.round(p * 1000) / 1000] as const];
        }),
    );
    const misfire = s.acted && !s.correct;
    return {
      ...base,
      ...meta,
      got: describe(got),
      probability: Math.round(got.probability * 1000) / 1000,
      correct: s.correct,
      intentCorrect: s.intentCorrect,
      misfire,
      misfireConfirmed:
        misfire && got.kind === "action" && CONFIRM.has(got.actionId),
      ms: Math.round(ms),
      topActions,
      slots,
      answers,
    };
  } catch (error) {
    return {
      ...base,
      ...meta,
      got: "error",
      probability: 0,
      correct: false,
      intentCorrect: false,
      misfire: false,
      misfireConfirmed: false,
      ms: 0,
      topActions: [],
      slots: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ] as number;
};

export function summarize(results: readonly CaseResult[]) {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    groups.set(r.category, [...(groups.get(r.category) ?? []), r]);
  }
  groups.set("all", [...results]);
  return [...groups].map(([category, rs]) => {
    const ok = rs.filter((r) => !r.error);
    const ms = ok.map((r) => r.ms);
    const right = rs.filter((r) => r.correct).length;
    const silentWrong = rs.filter(
      (r) => r.misfire && !r.misfireConfirmed,
    ).length;
    const safe = rs.filter(
      (r) => !r.correct && !r.error && (!r.misfire || r.misfireConfirmed),
    ).length;
    return {
      category,
      cases: rs.length,
      errors: rs.length - ok.length,
      right,
      safe,
      silentWrong,
      intentCorrect: rs.filter((r) => r.intentCorrect).length,
      misfires: rs.filter((r) => r.misfire).length,
      p50: Math.round(percentile(ms, 50)),
      p95: Math.round(percentile(ms, 95)),
    };
  });
}

export async function main(
  key: string,
  options: { repeat?: number; filter?: string; set?: string } = {},
): Promise<{ results: CaseResult[]; summary: ReturnType<typeof summarize> }> {
  const decide = typesafe(key);
  const set =
    options.set === "heldout"
      ? HELDOUT
      : options.set === "heldout2"
        ? HELDOUT2
        : options.set === "heldout3"
          ? HELDOUT3
          : options.set === "final"
            ? FINAL
            : options.set === "here"
              ? HERE
              : options.set === "realstt"
                ? REALSTT
                : options.set === "all"
                  ? ALL_CASES
                  : CASES;
  const cases = set.filter(
    (c) =>
      !options.filter ||
      c.id.includes(options.filter) ||
      c.category === options.filter ||
      // `--filter unoffered`: the cases asking for what the app can't do.
      (options.filter === "unoffered" && asksUnoffered(c)),
  );
  const results: CaseResult[] = [];
  for (let round = 0; round < (options.repeat ?? 1); round++)
    // One at a time, so latency is a single call's, as the voice box makes it.
    for (const c of cases) {
      const r = await runCase(decide, c);
      results.push(r);
      process.stderr.write(
        `${r.correct ? "✓" : "✗"} ${r.id} ${r.ms}ms "${r.spoken}" → ${r.got}${r.correct ? "" : ` (want ${r.expected})`}${r.error ? ` ERROR ${r.error}` : ""}\n`,
      );
    }
  return { results, summary: summarize(results) };
}
