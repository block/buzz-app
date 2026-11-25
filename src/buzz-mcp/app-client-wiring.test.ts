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

// The source of each `appClient(...)` call: from the opening parenthesis to its match.
const callArguments = (source: string): string[] =>
  [...source.matchAll(/\bappClient\(/g)].map((match) => {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth++;
      if (source[end] === ")") depth--;
      end++;
    }
    return source.slice(start, end);
  });

it("passes relayUrl in every appClient call", () => {
  const calls = walk("src")
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
    .filter((path) => !path.endsWith("buzz-mcp/app-client.ts"))
    .flatMap((path) =>
      callArguments(readFileSync(path, "utf8")).map((args) => ({ path, args })),
    );
  expect(calls.length).toBeGreaterThan(5);
  expect(
    calls.filter(({ args }) => !/\brelayUrl\b/.test(args)).map((c) => c.path),
  ).toEqual([]);
});
