import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Real preparation script and manifest; only the compiler toolchain is synthetic.
export function runtimeFixture(directory) {
  for (const name of ["scripts", "runtime", "bin"])
    mkdirSync(path.join(directory, name), { recursive: true });
  for (const name of [
    "scripts/build-agent-runtime.mjs",
    "runtime/agent-runtime.json",
  ])
    copyFileSync(
      new URL(`../../${name}`, import.meta.url),
      path.join(directory, name),
    );
  const tool = (name, body) =>
    writeFileSync(
      path.join(directory, "bin", name),
      `#!${process.execPath}\n${body}\n`,
      { mode: 0o755 },
    );
  tool("rustc", 'console.log("host: fixture-target");');
  tool(
    "cargo",
    `
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync("build-calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
if (fs.existsSync("fail-build")) process.exit(17);
const stage = process.argv[process.argv.indexOf("--root") + 1];
fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
const spec = JSON.parse(fs.readFileSync("runtime/agent-runtime.json", "utf8"));
for (const name of spec.tools) fs.writeFileSync(path.join(stage, "bin",
  process.platform === "win32" ? name + ".exe" : name), "fixture " + name, { mode: 0o755 });
`,
  );
}
