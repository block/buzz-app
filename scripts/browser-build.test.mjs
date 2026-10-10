import { expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { buildApp } from "../tests/browser/build.mjs";
vi.mock("vite", async (original) => ({
  ...(await original()),
  build: vi.fn(),
}));

test("ordinary browser builds exclude the development projection; only the opted-in worker supplies it", async () => {
  const config = async (bundledDevelopment) => {
    let result;
    await buildApp({ bundledDevelopment }, async (app) => {
      result = app.config;
    });
    return result;
  };
  expect((await config(false)).plugins.map(({ name }) => name)).not.toContain(
    "buzz-plugin-host-modules",
  );
  expect((await config(true)).plugins.map(({ name }) => name)).toContain(
    "buzz-plugin-host-modules",
  );
});

test("the development journey opts in; worker scope defaults off", async () => {
  const fixture = await readFile(
    new URL("../tests/browser/fixture.mjs", import.meta.url),
    "utf8",
  );
  const journey = await readFile(
    new URL("../tests/browser/inbox-plugin-dev.spec.mjs", import.meta.url),
    "utf8",
  );
  expect(
    fixture.includes(
      'bundledDevelopment: [false, { option: true, scope: "worker" }]',
    ),
  ).toBe(true);
  expect(journey).toContain("bundledDevelopment: true");
});
