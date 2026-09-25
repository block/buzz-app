import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function nativeFixtureRequired(report) {
  if (
    !Array.isArray(report.suites) ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0
  )
    throw new Error("Browser discovery failed");
  const collect = (suites) =>
    suites.flatMap((suite) => [...suite.specs, ...collect(suite.suites ?? [])]);
  const specs = collect(report.suites).filter((spec) => spec.tests.length > 0);
  if (specs.length === 0)
    throw new Error("Browser discovery selected no tests");
  // Playwright's JSON reporter omits the leading @ from tags.
  return specs.some((spec) => spec.tags.includes("native-fixture"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
  console.log(`native-fixture=${nativeFixtureRequired(report)}`);
}
