import { afterEach, expect, it, vi } from "vitest";
import {
  managedBy,
  managedLabel,
  offeredManaged,
  pendingManaged,
} from "./managed";
import { parseInstallOnlyRecommendations } from "./managed-config";
import type { ManagedEntry, ManagedPlugins } from "./types";

const entry = (id: string, state: ManagedEntry["state"]): ManagedEntry => ({
  id,
  repository: "https://example.com/plugins",
  reference: "v1",
  commit: "0".repeat(40),
  path: ".",
  state,
});
const policy = (
  ...plugins: ManagedEntry[]
): Extract<ManagedPlugins, { status: "ready" }> => ({
  status: "ready",
  path: "/managed-plugins.json",
  source: "Example Org",
  plugins,
  problems: [],
});

it("counts only recommendations that still need the user", () => {
  const managed = policy(
    entry("a.missing", "missing"),
    entry("b.outdated", "outdated"),
    entry("c.current", "current"),
    entry("d.other", "other"),
  );
  expect(pendingManaged(managed).map(({ id }) => id)).toEqual([
    "a.missing",
    "b.outdated",
  ]);
  expect(pendingManaged(undefined)).toEqual([]);
  expect(
    pendingManaged({ status: "invalid", path: "/p", reason: "Bad" }),
  ).toEqual([]);
});

it("attributes installed plugins to their managing source", () => {
  const managed = policy(
    entry("a.missing", "missing"),
    entry("b.outdated", "outdated"),
    entry("c.current", "current"),
    entry("d.other", "other"),
  );
  expect(managedBy(managed, "c.current")?.source).toBe("Example Org");
  expect(managedBy(managed, "b.outdated")?.source).toBe("Example Org");
  for (const id of ["a.missing", "d.other", "unlisted"])
    expect(managedBy(managed, id)).toBeUndefined();
  expect(managedBy(undefined, "c.current")).toBeUndefined();
});

it("offers manual entries only as updates to an installed copy", () => {
  const manual = (state: ManagedEntry["state"]): ManagedEntry => ({
    ...entry(`manual.${state}`, state),
    install: "manual",
  });
  const managed = policy(
    manual("missing"),
    manual("outdated"),
    manual("other"),
    { ...entry("auto.missing", "missing"), install: "automatic" },
  );
  expect(
    managed.status === "ready" &&
      managed.plugins
        .filter((item) => offeredManaged(item, managed.source))
        .map(({ id }) => id),
  ).toEqual(["manual.outdated", "auto.missing"]);
  expect(pendingManaged(managed).map(({ id }) => id)).toEqual([
    "manual.outdated",
    "auto.missing",
  ]);
});

it("labels automatically updated plugins with their source", () => {
  const managed = policy(
    { ...entry("a.auto", "current"), update: "automatic" },
    { ...entry("b.review", "current"), update: "review" },
    entry("c.default", "current"),
  );
  expect(managedLabel(managedBy(managed, "a.auto"))).toBe(
    "Example Org · updates automatically",
  );
  expect(managedLabel(managedBy(managed, "b.review"))).toBe("Example Org");
  expect(managedLabel(managedBy(managed, "c.default"))).toBe("Example Org");
  expect(managedLabel(undefined)).toBeUndefined();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("offers selected advisory bootstraps only until any copy is installed", async () => {
  vi.stubEnv(
    "VITE_BUZZ_INSTALL_ONLY_RECOMMENDATIONS",
    JSON.stringify([{ source: "Example Org", id: "example.bootstrap" }]),
  );
  vi.resetModules();
  const configured = await import("./managed");
  for (const modes of [
    {},
    { install: "recommend", update: "review" },
  ] as const) {
    for (const state of ["missing", "current", "outdated", "other"] as const) {
      const bootstrap = { ...entry("example.bootstrap", state), ...modes };
      const managed = policy(bootstrap, entry("example.other", "outdated"));
      expect(configured.offeredManaged(bootstrap, "Example Org")).toBe(
        state === "missing",
      );
      expect(configured.pendingManaged(managed).map(({ id }) => id)).toEqual(
        state === "missing"
          ? ["example.bootstrap", "example.other"]
          : ["example.other"],
      );
      expect(configured.managedBy(managed, bootstrap.id)).toBeUndefined();
      expect(configured.managedBy(managed, "example.other")).toBeDefined();
      expect(configured.offeredManaged(bootstrap, "Another Org")).toBe(
        state !== "current",
      );
      expect(
        !!configured.managedBy(
          { ...managed, source: "Another Org" },
          bootstrap.id,
        ),
      ).toBe(state === "current" || state === "outdated");
    }
  }
  // The same selectors must not hide an explicit install or update policy.
  for (const modes of [
    { install: "automatic" },
    { update: "automatic" },
    { install: "manual" },
  ] as const) {
    const bootstrap = { ...entry("example.bootstrap", "outdated"), ...modes };
    expect(configured.offeredManaged(bootstrap, "Example Org")).toBe(true);
    expect(configured.managedBy(policy(bootstrap), bootstrap.id)).toBeDefined();
  }
});

it("validates distributor selectors without changing policy schemas", () => {
  expect(parseInstallOnlyRecommendations("")).toEqual([]);
  const selectors = [{ source: "Example Org", id: "example.bootstrap" }];
  expect(parseInstallOnlyRecommendations(JSON.stringify(selectors))).toEqual(
    selectors,
  );
  for (const value of [
    "null",
    "{}",
    "[null]",
    '[{"id":"example.bootstrap"}]',
    '[{"source":" ","id":"example.bootstrap"}]',
    '[{"source":"Example Org","id":"example.bootstrap","update":"automatic"}]',
    "not json",
  ]) {
    expect(() => parseInstallOnlyRecommendations(value)).toThrow(
      "Install-only recommendations",
    );
  }
});
