#!/usr/bin/env node
// Scores saved eval answers again under the decision rules in the working
// tree, with no calls to Jev: for trying a rule change against every set at
// once. Pass results files from `run.mjs --out`; run with the same
// VOICE_EVAL_SCALE they were made with.
//
//   bin/node scripts/voice-actions-eval/rescore.mjs RESULTS.json…
import { readFile } from "node:fs/promises";
import process from "node:process";
import { runnerImport } from "vite";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: rescore.mjs RESULTS.json…");
  process.exit(2);
}
const { module } = await runnerImport(
  new URL("./eval.ts", import.meta.url).pathname,
  { configFile: false, logLevel: "error" },
);
const byId = new Map(module.ALL_CASES.map((c) => [c.id, c]));
const rows = [];
for (const file of files) {
  const { results } = JSON.parse(await readFile(file, "utf8"));
  const tally = { file, calls: 0, right: 0, safe: 0, silent: 0, changed: 0 };
  for (const saved of results) {
    const c = byId.get(saved.id);
    if (!c || !saved.answers) continue;
    const now = module.rescoreCase(c, saved.answers);
    tally.calls++;
    if (now.correct) tally.right++;
    else if (now.misfire && !now.misfireConfirmed) tally.silent++;
    else tally.safe++;
    if (now.got !== saved.got) {
      tally.changed++;
      console.error(
        `${saved.id} "${saved.spoken}": ${saved.got} → ${now.got}${now.correct ? " ✓" : ` (want ${saved.expected})`}`,
      );
    }
  }
  rows.push(tally);
}
console.table(rows);
