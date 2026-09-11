import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/shared/design-system/**/*.test.ts",
      "tests/fixtures/design-system/**/*.test.ts",
    ],
  },
});
