/** Advisory source census. Counts files, not rendered instances or compliance.
 * Includes app screens, shared recipes and renderer string reads; viewer-only
 * experiments and documentation are reported separately. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const SRC = join(ROOT, "src/shared/design-system");
const VIEWER = new URL("../../tests/fixtures/design-system", import.meta.url)
  .pathname;
const TOKENS = join(SRC, "styles/tokens.css");
const APP = join(ROOT, "src");

/** Files that describe the system rather than use it. */
const isDocs = (path) =>
  path.includes("tests/fixtures/design-system/") ||
  path.includes("styles/design-components.css") ||
  path.includes("tokens/registry.ts") ||
  /(?:BentoWorkspace|FlexWorkspace|MultiPanelSwapExperiment|SwapWorkspaceExperiment)\.tsx$/.test(
    path,
  ) ||
  (/styles\/(?:bento|flex-workspace|multi-panel-swap|swap-workspace|globals)\.css$/.test(
    path,
  ) &&
    path.includes("design-system/"));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      /\.(css|tsx?|js)$/.test(full) &&
      !/(?:\.test\.|\.spec\.|(?:^|\/)(?:session-)?fixture\.)/.test(full)
    )
      out.push(full);
  }
  return out;
}

const css = readFileSync(TOKENS, "utf8");

// Role declarations live outside `@theme`; registrations live inside it.
const themeStart = css.indexOf("@theme inline {");
const roleBlock = css.slice(0, themeStart);
const themeBlock = css.slice(themeStart);

const roles = new Set(
  [
    ...roleBlock.matchAll(
      /^\s*(--(?:bg|surface|text|border|affordance)-[a-z0-9-]+):/gm,
    ),
  ].map((m) => m[1]),
);

// What Tailwind class does each role register as? `--color-info: var(--bg-info)`
// means `bg-info` / `text-info` reach `--bg-info`.
// Order matters: `--text-color-error` must match the `text-color` namespace, not
// `text` with the suffix `color-error`. Longest prefix first.
const NAMESPACES = ["text-color", "border-color", "color"];
const registrations = new Map(); // role -> [{ ns, suffix }]
for (const [, ns, suffix, role] of themeBlock.matchAll(
  new RegExp(
    String.raw`^\s*--(${NAMESPACES.join("|")})-([a-z0-9-]+):\s*var\((--[a-z0-9-]+)\)`,
    "gm",
  ),
)) {
  if (!registrations.has(role)) registrations.set(role, []);
  registrations.get(role).push({ ns, suffix });
}

const files = [...walk(APP), ...walk(VIEWER)].filter((f) => f !== TOKENS);
const counts = new Map([...roles].map((r) => [r, { product: [], docs: [] }]));

for (const file of files) {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const rel = relative(ROOT, file);
  const bucket = isDocs(file) ? "docs" : "product";

  for (const role of roles) {
    const hits = [];
    if (new RegExp(`var\\(\\s*${role}\\s*[,)]`).test(text)) hits.push("var()");
    if (text.includes(`"${role}"`) || text.includes(`'${role}'`))
      hits.push("adapter string");

    for (const { ns, suffix } of registrations.get(role) ?? []) {
      // `--color-info` is reachable as bg-info, text-info, border-info…
      const prefixes =
        ns === "color"
          ? [
              "bg",
              "text",
              "border",
              "fill",
              "stroke",
              "ring",
              "outline",
              "shadow",
              "from",
              "to",
              "via",
            ]
          : ns === "border-color"
            ? ["border"]
            : ["text"]; // text-color
      for (const p of prefixes) {
        // Word-bounded so `bg-info` does not match `bg-info-tint`.
        if (new RegExp(`\\b(?:[a-z-]+:)?${p}-${suffix}\\b(?!-)`).test(text)) {
          hits.push(`${p}-${suffix}`);
          break;
        }
      }
    }

    if (hits.length)
      counts
        .get(role)
        [bucket].push(`${rel} (${[...new Set(hits)].join(", ")})`);
  }
}

const dead = [];
const docsOnly = [];
const live = [];
for (const [role, { product, docs }] of counts) {
  if (product.length) live.push([role, product]);
  else if (docs.length) docsOnly.push([role, docs]);
  else dead.push(role);
}

console.log(`\n${roles.size} roles declared.\n`);
console.log(`── Zero readers anywhere (${dead.length}) ──`);
for (const role of dead.sort()) console.log(`  ${role}`);
console.log(`\n── Read only by the docs (${docsOnly.length}) ──`);
for (const [role, where] of docsOnly.sort())
  console.log(`  ${role}  ← ${where.join("; ")}`);
console.log(`\n── Read by product code (${live.length}) ──`);
for (const [role, where] of live.sort((a, b) => a[1].length - b[1].length)) {
  console.log(`  ${role}  ×${where.length}`);
  for (const w of where) console.log(`      ${w}`);
}
