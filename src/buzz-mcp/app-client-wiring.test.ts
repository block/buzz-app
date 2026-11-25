import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// An agent runtime that builds its tools' client without the relay address
// silently skips the channel naming rules, so every call site must pass it.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

it("passes relayUrl wherever a runtime builds an appClient", () => {
  const sites = walk("src")
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
    .filter((path) => !path.endsWith("buzz-mcp/app-client.ts"))
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .flatMap(({ path, source }) => {
      const calls = source.match(/\bappClient\(/g)?.length ?? 0;
      const passes = source.match(/\brelayUrl\b/g)?.length ?? 0;
      return calls ? [{ path, calls, passes }] : [];
    });
  expect(sites.length).toBeGreaterThan(5);
  expect(sites.filter(({ calls, passes }) => passes < calls)).toEqual([]);
});
