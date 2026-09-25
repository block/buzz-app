import type { MemoryEntry } from "../../features/agents/memory";

export const recipeTitles = {
  "small-task": "Do one small thing",
  "remember-world": "Remember my world",
  "check-in": "Set up a check-in",
} as const;
export const purposeTitles = {
  onboarding: "Onboarding review",
  commitments: "Commitment review",
  dream: "Dream reflection",
} as const;
export type Source = { event: string; quote: string };
export type MemoryRecord = {
  title: string;
  links: string[];
  revisions: { text: string; source: Source; at: number }[];
  workflow?: string;
};
export type Baseline = {
  version: 1;
  owner: string;
  channel: string;
  revision: number;
  recipes: Record<
    keyof typeof recipeTitles,
    { status: string; evidence: Source[] }
  >;
  cadences: Record<
    keyof typeof purposeTitles,
    { enabled: boolean; interval: number; nextDue: number }
  >;
  memory: Record<string, Record<string, MemoryRecord>>;
  notes: { event: string; at: number; changes: string[] }[];
  dreams: { at: number; summary: string; status: string; sources: Source[] }[];
  runs: { purpose: string; at: number; summary: string; trigger: string }[];
};
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const strings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((v) => typeof v === "string");
const time = (x: unknown) =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const source = (x: unknown) =>
  object(x) &&
  typeof x.event === "string" &&
  /^[0-9a-f]{64}$/.test(x.event) &&
  typeof x.quote === "string";
const sources = (x: unknown) => Array.isArray(x) && x.every(source);

/** Memory is model-produced input. A malformed projection never enables controls. */
export function parseBaseline(entry: MemoryEntry): Baseline | undefined {
  try {
    const x: unknown = JSON.parse(entry.body);
    if (
      !object(x) ||
      x.version !== 1 ||
      typeof x.owner !== "string" ||
      typeof x.channel !== "string" ||
      !time(x.revision)
    )
      return;
    if (!object(x.recipes) || !object(x.cadences) || !object(x.memory)) return;
    for (const key of Object.keys(recipeTitles)) {
      const recipe = x.recipes[key];
      if (
        !object(recipe) ||
        !["available", "offered", "accepted", "skipped", "completed"].includes(
          String(recipe.status),
        ) ||
        !sources(recipe.evidence)
      )
        return;
    }
    for (const key of Object.keys(purposeTitles)) {
      const cadence = x.cadences[key];
      if (
        !object(cadence) ||
        typeof cadence.enabled !== "boolean" ||
        !time(cadence.interval) ||
        !time(cadence.nextDue)
      )
        return;
    }
    for (const section of Object.values(x.memory)) {
      if (!object(section)) return;
      for (const row of Object.values(section)) {
        if (
          !object(row) ||
          typeof row.title !== "string" ||
          !strings(row.links) ||
          !Array.isArray(row.revisions) ||
          !row.revisions.length ||
          (row.workflow !== undefined && typeof row.workflow !== "string")
        )
          return;
        if (
          !row.revisions.every(
            (r) =>
              object(r) &&
              typeof r.text === "string" &&
              source(r.source) &&
              time(r.at),
          )
        )
          return;
      }
    }
    if (
      !Array.isArray(x.notes) ||
      !x.notes.every(
        (n) =>
          object(n) &&
          typeof n.event === "string" &&
          time(n.at) &&
          strings(n.changes),
      )
    )
      return;
    if (
      !Array.isArray(x.dreams) ||
      !x.dreams.every(
        (d) =>
          object(d) &&
          time(d.at) &&
          typeof d.summary === "string" &&
          typeof d.status === "string" &&
          sources(d.sources),
      )
    )
      return;
    if (
      !Array.isArray(x.runs) ||
      !x.runs.every(
        (r) =>
          object(r) &&
          time(r.at) &&
          typeof r.purpose === "string" &&
          typeof r.summary === "string" &&
          typeof r.trigger === "string",
      )
    )
      return;
    return x as Baseline;
  } catch {
    return;
  }
}
