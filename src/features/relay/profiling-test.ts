import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayProfiler } from "./profiling";

/** Optional artifacts for integration runs; never imported by application code. */
export function writeProfile(
  name: string,
  profiling: RelayProfiler,
  measurements: Record<string, number> = {},
) {
  const directory = process.env.RELAY_PROFILE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify({ measurements, timings: profiling.snapshot() }, null, 2),
  );
}
