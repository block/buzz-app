import { defineConfig } from "vitest/config";
import { fixtureAliases } from "./tests/relay-config.ts";
const workerLimit = process.env.BUZZ_TEST_WORKERS;
const maxWorkers = workerLimit === undefined ? undefined : Number(workerLimit);
if (
  maxWorkers !== undefined &&
  (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1)
) {
  throw new Error("BUZZ_TEST_WORKERS must be a positive integer");
}

export default defineConfig({
  define: {
    "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
      JSON.stringify(fixtureAliases),
  },
  test: {
    maxWorkers,
    include: [
      "src/**/*.test.{ts,tsx,mjs}",
      "dev/**/*.test.mjs",
      "tests/fixtures/design-system/**/*.test.{ts,tsx}",
    ],
  },
});
