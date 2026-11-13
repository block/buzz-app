export type LaneRule = Readonly<{
  id: string;
  field: "title" | "label" | "files" | "path";
  operator:
    | "contains"
    | "not-contains"
    | "has"
    | "not-has"
    | "at-least"
    | "at-most"
    | "matches"
    | "not-matches";
  value: string;
}>;
export type LaneRouting = Readonly<{
  mode: "all" | "any";
  rules: readonly LaneRule[];
}>;
export type PullFacts = Readonly<{
  repository: string;
  pr: number;
  title: string;
  labels: readonly string[];
  changedFiles: number;
  paths: readonly string[];
  head: string;
  base: string;
}>;
export const ruleFields = [
  { value: "title", label: "Title" },
  { value: "label", label: "Label" },
  { value: "files", label: "Total changed files" },
  { value: "path", label: "Changed file path" },
] as const;
export const ruleOperators = {
  title: [
    { value: "contains", label: "contains" },
    { value: "not-contains", label: "does not contain" },
  ],
  label: [
    { value: "has", label: "includes" },
    { value: "not-has", label: "does not include" },
  ],
  files: [
    { value: "at-least", label: "is at least" },
    { value: "at-most", label: "is at most" },
  ],
  path: [
    { value: "matches", label: "matches pattern" },
    { value: "not-matches", label: "does not match pattern" },
  ],
} as const;

export function validateRouting(raw: unknown): LaneRouting {
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid lane routing rules.");
  const value = raw as LaneRouting;
  if (
    !["all", "any"].includes(value.mode) ||
    !Array.isArray(value.rules) ||
    value.rules.length > 12
  )
    throw new Error("Choose all or any, with up to 12 routing rules per lane.");
  const ids = new Set<string>();
  const rules = value.rules.map((rule: LaneRule) => {
    if (
      !rule ||
      typeof rule.id !== "string" ||
      !/^[a-z0-9-]{1,64}$/i.test(rule.id) ||
      ids.has(rule.id) ||
      !Object.hasOwn(ruleOperators, rule.field) ||
      !ruleOperators[rule.field].some((item) => item.value === rule.operator) ||
      typeof rule.value !== "string" ||
      !rule.value.trim() ||
      rule.value.length > 200
    )
      throw new Error(
        "Each routing rule needs a valid field, comparison, and value (up to 200 characters).",
      );
    ids.add(rule.id);
    const text = rule.value.trim();
    if (
      rule.field === "files" &&
      (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    )
      throw new Error(
        "Changed-file counts must be whole numbers of zero or more.",
      );
    if (
      rule.field === "path" &&
      (text.startsWith("/") ||
        /[\\[\]{}]/.test(text) ||
        text
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              (part.includes("**") && part !== "**"),
          ))
    )
      throw new Error(
        "Use a repository-relative path pattern with *, ?, or ** as a whole directory segment.",
      );
    return {
      id: rule.id,
      field: rule.field,
      operator: rule.operator,
      value: text,
    };
  });
  return { mode: value.mode, rules };
}

// Remember only the latest wildcard; avoid allocating a matrix for each filename.
function segmentMatches(pattern: string, text: string) {
  let p = 0;
  let t = 0;
  let star = -1;
  let retry = 0;
  while (t < text.length) {
    if (pattern[p] === "?" || pattern[p] === text[t]) {
      p++;
      t++;
    } else if (pattern[p] === "*") {
      star = p++;
      retry = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++retry;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
export function pathMatches(pattern: string, path: string) {
  const segments = path.split("/");
  let row = Array<boolean>(segments.length + 1).fill(false);
  row[0] = true;
  for (const part of pattern.split("/")) {
    const next = Array<boolean>(segments.length + 1).fill(false);
    next[0] = part === "**" && !!row[0];
    for (let i = 1; i <= segments.length; i++)
      next[i] =
        part === "**"
          ? !!row[i] || !!next[i - 1]
          : !!row[i - 1] && segmentMatches(part, segments[i - 1] ?? "");
    row = next;
  }
  return !!row[segments.length];
}
export function laneMatches(
  routing: LaneRouting | undefined,
  facts: PullFacts,
): boolean {
  if (!routing?.rules.length) return true;
  const matches = (rule: LaneRule) => {
    const positive =
      rule.field === "title"
        ? facts.title.toLowerCase().includes(rule.value.toLowerCase())
        : rule.field === "label"
          ? facts.labels.some(
              (label) => label.toLowerCase() === rule.value.toLowerCase(),
            )
          : rule.field === "files"
            ? rule.operator === "at-least"
              ? facts.changedFiles >= Number(rule.value)
              : facts.changedFiles <= Number(rule.value)
            : facts.paths.some((path) => pathMatches(rule.value, path));
    return rule.operator.startsWith("not-") ? !positive : positive;
  };
  return routing.mode === "all"
    ? routing.rules.every(matches)
    : routing.rules.some(matches);
}
