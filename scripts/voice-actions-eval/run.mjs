#!/usr/bin/env node
// Voice-actions eval against the real decision service (TypeSafe System One,
// Jev). Needs a TypeSafe key in TYPESAFE_API_KEY or ~/.typesafe; without one
// it stops rather than mock the service.
//
//   bin/node scripts/voice-actions-eval/run.mjs [--repeat N] [--filter ID|CATEGORY] [--set tuned|heldout|heldout2|heldout3|final|here|realstt|all] [--out FILE.json]
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { runnerImport } from "vite";

const { values } = parseArgs({
  options: {
    repeat: { type: "string", default: "1" },
    filter: { type: "string" },
    out: { type: "string" },
    // tuned (default), heldout, heldout2, heldout3, final, here, realstt, or all.
    set: { type: "string", default: "tuned" },
  },
});
let key = process.env.TYPESAFE_API_KEY?.trim();
if (!key) {
  try {
    key = (await readFile(join(homedir(), ".typesafe"), "utf8")).trim();
  } catch {
    // Reported below.
  }
}
if (!key || /\s/.test(key)) {
  console.error(
    "No TypeSafe key: set TYPESAFE_API_KEY or write it to ~/.typesafe. Not mocking the service.",
  );
  process.exit(2);
}
const { module } = await runnerImport(
  new URL("./eval.ts", import.meta.url).pathname,
  { configFile: false, logLevel: "error" },
);
const { results, summary } = await module.main(key, {
  repeat: Number(values.repeat),
  filter: values.filter,
  set: values.set,
});
console.table(summary);
if (values.out) {
  await writeFile(
    values.out,
    `${JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2)}\n`,
  );
  console.error(`Wrote ${values.out}`);
}
