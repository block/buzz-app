import { afterAll, beforeAll, expect, test } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pluginCatalog, pluginGraph, root } from "./plugin-graph.mjs";

let directory;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "plugin-graph-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function source(path, content) {
  const file = join(directory, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function fixture() {
  await source("src/main.tsx", 'import "./shared/state"; import "./bundled";');
  await source(
    "src/shared/state.ts",
    'import {useState} from "react"; export const state = useState;',
  );
  await source(
    "src/bundled/index.ts",
    `
import manifest from "./future/manifest.json";
import * as module from "./future";
export const bundledPlugins = [{manifest: {...manifest, apiVersion: 1}, module, enabledByDefault: false}];`,
  );
  await source(
    "src/bundled/future/manifest.json",
    JSON.stringify({ id: "future.plugin", name: "Future", apiVersion: 1 }),
  );
  await source(
    "src/bundled/future/index.tsx",
    `
import type {Absent} from "./never-created";
import {state} from "../../shared/state";
export {state};
export const render = () => import("./renderer");`,
  );
  await source(
    "src/bundled/future/renderer.ts",
    'import {Widget} from "private-vendor"; import "private-vendor/widget.css"; export {Widget};',
  );
}

test("discovers current catalog identities, not unregistered manifest directories", async () => {
  const catalog = await pluginCatalog();
  expect(catalog.map(({ manifest }) => manifest.id)).toContain(
    "block.builderlab",
  );
  expect(catalog.map(({ slug }) => slug)).not.toContain("link-lab");
  expect(new Set(catalog.map(({ manifest }) => manifest.id)).size).toBe(
    catalog.length,
  );
});

test("new catalog plugins participate automatically, with private lazy vendors and shared runtime imports", async () => {
  await fixture();
  const graph = await pluginGraph(directory);
  expect(graph.catalog.map(({ manifest }) => manifest.id)).toEqual([
    "future.plugin",
  ]);
  expect(graph.catalog[0].enabledByDefault).toBe(false);
  const imports = graph.dependencies(graph.catalog[0]);
  expect([...imports.keys()].sort()).toEqual([
    "react",
    "react/jsx-runtime",
    "shared/state",
  ]);
  expect([...imports.get("shared/state").names]).toEqual(["state"]);
  expect(
    graph.nodes.has(join(directory, "src/bundled/future/renderer.ts")),
  ).toBe(true);
  expect([...graph.vendorOwners.get("private-vendor")]).toEqual([
    "future.plugin",
  ]);
  expect(graph.violations).toEqual([]);
});

test("a vendor reached outside its plugin is shared, and lazy host dependencies stay lazy", async () => {
  await fixture();
  await source(
    "src/shared/state.ts",
    'import "private-vendor"; export const state = {};',
  );
  await source("src/shared/lazy.ts", "export const value = {};");
  await source(
    "src/bundled/future/renderer.ts",
    'export const lazy = () => import("../../shared/lazy"); import {Widget} from "private-vendor"; export {Widget};',
  );
  const graph = await pluginGraph(directory);
  const imports = graph.dependencies(graph.catalog[0]);
  expect(imports.has("private-vendor")).toBe(true);
  expect(imports.get("shared/lazy").lazy).toBe(true);
  expect([...imports.get("shared/lazy").names]).toEqual(["*"]);
});

test("host source leakage is observable even for lazy imports", async () => {
  await fixture();
  await source(
    "src/main.tsx",
    'import "./bundled"; export const leaked = () => import("./bundled/future/renderer");',
  );
  const graph = await pluginGraph(directory);
  expect(graph.violations).toEqual([
    "src/main.tsx -> src/bundled/future/renderer.ts",
  ]);
  expect(graph.vendorOwners.get("private-vendor").has("host")).toBe(true);
});

test("unsupported catalog shapes and nonliteral plugin imports fail rather than silently opt out", async () => {
  await fixture();
  await source(
    "src/bundled/future/index.tsx",
    "export const lazy = (path) => import(path);",
  );
  await expect(pluginGraph(directory)).rejects.toThrow("must be literal");
  await source(
    "src/bundled/index.ts",
    "export const bundledPlugins = factory();",
  );
  await expect(pluginCatalog(directory)).rejects.toThrow(
    "Unsupported bundled plugin catalog",
  );
});

test("the ownership migration baseline can shrink but never grow", async () => {
  const baseline = JSON.parse(
    await readFile(
      join(root, "scripts/plugin-ownership-baseline.json"),
      "utf8",
    ),
  );
  const graph = await pluginGraph();
  expect(graph.violations.filter((edge) => !baseline.includes(edge))).toEqual(
    [],
  );
  const checkout = join(directory, "ratchet");
  await cp(join(root, "src"), join(checkout, "src"), { recursive: true });
  await cp(
    join(root, "crates/agent-controller/src/harness-presets.json"),
    join(checkout, "crates/agent-controller/src/harness-presets.json"),
    { recursive: true },
  );
  const path = join(checkout, "src/main.tsx");
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\nimport "./bundled/inbox/InboxPage";\n`,
  );
  const changed = await pluginGraph(checkout);
  expect(changed.violations.filter((edge) => !baseline.includes(edge))).toEqual(
    ["src/main.tsx -> src/bundled/inbox/InboxPage.tsx"],
  );
});
