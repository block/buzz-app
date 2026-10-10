import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBundledDev,
  bundledHostPlugin,
  bundledPublicConfig,
  hostBuildId,
} from "./plugin-dev.mjs";
import { pluginGraph, root } from "./plugin-graph.mjs";

let directory;
let checkout;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bundled-dev-test-"));
  checkout = join(directory, "checkout");
  for (const path of [
    "src",
    "scripts",
    "crates",
    "src-tauri/src",
    "vite.config.ts",
    "package.json",
    "pnpm-lock.yaml",
    "postcss.config.js",
    ".gitignore",
  ])
    await cp(join(root, path), join(checkout, path), { recursive: true });
  await symlink(
    join(root, "node_modules"),
    join(checkout, "node_modules"),
    "dir",
  );
  execFileSync("git", ["init", "--quiet", checkout]);
}, 30000);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const build = (plugin, out = join(directory, plugin)) =>
  buildBundledDev({ plugin, directory: checkout, out });

test("same-ID builds preserve catalog metadata, lifecycle CSS and host compatibility without copying shared state", async () => {
  const result = await build("inbox");
  const manifest = JSON.parse(
    await readFile(join(result.out, "manifest.json"), "utf8"),
  );
  expect(manifest).toEqual({ id: "buzz.inbox", name: "Inbox", apiVersion: 1 });
  expect(
    JSON.parse(await readFile(join(result.out, "plugin.dev.json"), "utf8")),
  ).toEqual({ version: 1, id: "buzz.inbox", hostBuildId: result.buildId });
  const code = await readFile(join(result.out, "plugin.js"), "utf8");
  expect(code).toContain("__BUZZ_HOST_MODULES__");
  expect(code).toContain("style.remove()");
  expect(code).not.toContain("__BUZZ_PLUGIN_DEV_CSS__");
  expect(code).not.toContain("new WeakMap");
  await expect(
    import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    ),
  ).rejects.toThrow("different Buzz development host");
  const previous = globalThis.__BUZZ_HOST_MODULES__;
  try {
    globalThis.__BUZZ_HOST_MODULES__ = {
      fingerprints: { "buzz.inbox": null },
      modules: {},
    };
    await expect(
      import(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#unavailable`
      ),
    ).rejects.toThrow("different Buzz development host");
  } finally {
    if (previous === undefined) delete globalThis.__BUZZ_HOST_MODULES__;
    else globalThis.__BUZZ_HOST_MODULES__ = previous;
  }
});

test("React namespace shims use the production runtime exports, not Node's synthetic development names", async () => {
  const result = await build("inbox", join(directory, "react-runtime"));
  const code = await readFile(join(result.out, "plugin.js"), "utf8");
  expect(code).toContain('"useState"');
  expect(code).not.toContain('"act"');
  expect(code).not.toContain('"captureOwnerStack"');
});

test("Builderlab artifacts preserve the public deployment target and exact-origin grant", async () => {
  vi.stubEnv("BUZZ_BUILDERLAB_URL", "https://login.example:8443/deployment/");
  try {
    const result = await build(
      "builderlab",
      join(directory, "builderlab-config"),
    );
    const manifest = JSON.parse(
      await readFile(join(result.out, "manifest.json"), "utf8"),
    );
    const code = await readFile(join(result.out, "plugin.js"), "utf8");
    expect(code.match(/function oauthTarget\([^)]*\)/)?.[0]).toBe(
      'function oauthTarget(value = "https://login.example:8443/deployment/")',
    );
    expect(manifest.host).toEqual({
      commands: [],
      networkOrigins: ["https://login.example:8443"],
    });
    expect(result.buildId).toBe(await hostBuildId("builderlab", checkout));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Builderlab host projection matches the public target and rejects different deployment paths", async () => {
  vi.stubEnv("BUZZ_BUILDERLAB_URL", "https://login.example:8443/deployment/");
  try {
    const graph = await pluginGraph(checkout);
    const buildId = await hostBuildId("builderlab", checkout, graph);
    const projection = await bundledHostPlugin(checkout).load.call(
      { warn: vi.fn() },
      "\0virtual:buzz-plugin-host",
    );
    expect(projection).toContain(`"block.builderlab":"${buildId}"`);
    vi.stubEnv("BUZZ_BUILDERLAB_URL", "https://login.example:8443/other/");
    expect(await hostBuildId("builderlab", checkout, graph)).not.toBe(buildId);
    vi.stubEnv("BUZZ_BUILDERLAB_URL", "");
    expect(await hostBuildId("builderlab", checkout, graph)).not.toBe(buildId);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("public config uses development files and explicit process overrides, without unrelated inputs", async () => {
  const fixture = join(directory, "public-config");
  await mkdir(fixture);
  await writeFile(
    join(fixture, ".env.local"),
    "BUZZ_BUILDERLAB_URL=https://local.example/path/\nPRIVATE_VALUE=must-not-ship\n",
  );
  await writeFile(
    join(fixture, ".env.development"),
    "BUZZ_BUILDERLAB_URL=https://development.example/\n",
  );
  await writeFile(
    join(fixture, ".env.production"),
    "BUZZ_BUILDERLAB_URL=https://production.example/\n",
  );
  const saved = process.env.BUZZ_BUILDERLAB_URL;
  delete process.env.BUZZ_BUILDERLAB_URL;
  try {
    expect(bundledPublicConfig(fixture)).toEqual({
      builderlabUrl: "https://development.example/",
    });
    expect(bundledPublicConfig(fixture, "production")).toEqual({
      builderlabUrl: "https://production.example/",
    });
    vi.stubEnv("BUZZ_BUILDERLAB_URL", "https://process.example/");
    expect(bundledPublicConfig(fixture)).toEqual({
      builderlabUrl: "https://process.example/",
    });
    vi.stubEnv("BUZZ_BUILDERLAB_URL", "");
    expect(bundledPublicConfig(fixture)).toEqual({ builderlabUrl: "" });
  } finally {
    vi.unstubAllEnvs();
    if (saved === undefined) delete process.env.BUZZ_BUILDERLAB_URL;
    else process.env.BUZZ_BUILDERLAB_URL = saved;
  }
});

test("Builderlab rejects invalid public targets without echoing them or replacing a healthy artifact", async () => {
  const out = join(directory, "builderlab-config");
  await buildBundledDev({
    plugin: "builderlab",
    directory: checkout,
    out,
    publicConfig: { builderlabUrl: "" },
  });
  const before = await readFile(join(out, "plugin.js"), "utf8");
  for (const builderlabUrl of [
    "http://login.example",
    "https://user:secret@login.example",
    "https://login.example?",
    "https://login.example#",
    "invalid",
  ]) {
    await expect(
      buildBundledDev({
        plugin: "builderlab",
        directory: checkout,
        out,
        publicConfig: { builderlabUrl },
      }),
    ).rejects.toThrow(/Builderlab build URL/);
    expect(await readFile(join(out, "plugin.js"), "utf8")).toBe(before);
  }
});

test("plugin-only edits preserve matching host identity and generate utilities without copying host CSS", async () => {
  const out = join(directory, "utilities");
  const before = await build("inbox", out);
  const entry = join(checkout, "src/bundled/inbox/index.tsx");
  const original = await readFile(entry, "utf8");
  try {
    await writeFile(
      entry,
      `${original}\n// ${["[word-spacing:", "3.7px]"].join("")} p-13 bg-muted dark:p-17 animate-ping\n`,
    );
    const after = await build("inbox", out);
    expect(after.buildId).toBe(before.buildId);
    const code = await readFile(join(out, "plugin.js"), "utf8");
    const css = JSON.parse(code.match(/style.textContent = (".*");/)[1]);
    expect(css).toContain("word-spacing: 3.7px");
    expect(css).toContain("padding: calc(var(--space-1) * 13)");
    expect(css).toContain("background-color: var(--text-muted)");
    expect(css).toContain('[data-color-mode="dark"]');
    expect(css).toContain("@keyframes ping");
    expect(css).not.toContain("@layer base");
    expect(css).not.toContain("box-sizing: border-box");
    expect(css).not.toContain(".panel-header");
  } finally {
    await writeFile(entry, original);
  }
});

test("new host imports/exports and shared edits change compatibility, but plugin-only edits do not", async () => {
  const fixture = join(directory, "fingerprint");
  await mkdir(join(fixture, "src/bundled/future"), { recursive: true });
  await mkdir(join(fixture, "src/shared"), { recursive: true });
  await writeFile(join(fixture, "src/main.tsx"), 'import "./bundled";');
  await writeFile(
    join(fixture, "src/bundled/index.ts"),
    'import manifest from "./future/manifest.json"; import * as module from "./future"; export const bundledPlugins = [{manifest: {...manifest, apiVersion: 1}, module, enabledByDefault: false}];',
  );
  await writeFile(
    join(fixture, "src/bundled/future/manifest.json"),
    JSON.stringify({ id: "future.plugin", name: "Future", apiVersion: 1 }),
  );
  const entry = join(fixture, "src/bundled/future/index.tsx");
  const shared = join(fixture, "src/shared/state.ts");
  await writeFile(entry, 'export {state} from "../../shared/state";');
  await writeFile(shared, "export const state = {}; export const value = {};");
  execFileSync("git", ["init", "--quiet", fixture]);
  const before = await hostBuildId("future", fixture);
  await writeFile(
    entry,
    'export {state} from "../../shared/state"; export const local = 1;',
  );
  expect(await hostBuildId("future", fixture)).toBe(before);
  await writeFile(entry, 'export {state, value} from "../../shared/state";');
  expect(await hostBuildId("future", fixture)).not.toBe(before);
  await writeFile(entry, 'export {state} from "../../shared/state";');
  await writeFile(
    shared,
    "export const state = {changed: true}; export const value = {};",
  );
  expect(await hostBuildId("future", fixture)).not.toBe(before);
});

test("refuses unknown/alternate identities, private ownership leaks, destructive output and unrelated output files", async () => {
  await expect(build("local.inbox-dev")).rejects.toThrow(
    "Unknown bundled plugin",
  );
  await expect(build("me")).rejects.toThrow("consumed outside");
  await expect(build("inbox", checkout)).rejects.toThrow("source checkout");
  await expect(
    build("inbox", join(checkout, "src/bundled/inbox")),
  ).rejects.toThrow("source checkout");
  const out = join(directory, "protected");
  await build("inbox", out);
  await writeFile(join(out, "precious.txt"), "keep");
  await expect(build("inbox", out)).rejects.toThrow("files other than");
  expect(await readFile(join(out, "precious.txt"), "utf8")).toBe("keep");
});

test("private lazy/vendor CSS/fonts build into one module; shared CSS module values remain host-owned", async () => {
  for (const plugin of ["terminal", "diffs", "links"]) {
    const result = await build(plugin);
    const code = await readFile(join(result.out, "plugin.js"), "utf8");
    expect(code).not.toMatch(/\bimport\s*\(/);
    if (plugin === "terminal") {
      expect(code).toContain("data:font/woff2;base64,");
      expect(code).toContain(".xterm");
    }
    if (plugin === "links") {
      expect(code).toContain("shared/InlineReference.module.css");
      const css = JSON.parse(code.match(/style.textContent = (".*");/)[1]);
      expect(css).not.toContain(".inlineReference");
    }
  }
}, 30000);

test("all catalog entries get a build or an explicit remaining ownership blocker, never a silent exception", async () => {
  const graph = await pluginGraph(checkout);
  for (const plugin of graph.catalog) {
    const blocked = graph.violations.some((edge) =>
      edge.split(" -> ")[1].startsWith(`src/bundled/${plugin.slug}/`),
    );
    if (blocked)
      await expect(build(plugin.slug)).rejects.toThrow("consumed outside");
    else expect((await build(plugin.slug)).id).toBe(plugin.manifest.id);
  }
}, 120000);

test("host map does not eagerly project plugin-private Terminal/Diff vendors", async () => {
  const warn = vi.fn();
  const generated = await bundledHostPlugin(checkout).load.call(
    { warn },
    "\0virtual:buzz-plugin-host",
  );
  expect(generated).toContain('"buzz.inbox"');
  expect(generated).toContain('"block.builderlab"');
  expect(generated).not.toContain('from "@xterm/');
  expect(generated).not.toContain('from "react-diff-view');
  expect(generated).not.toContain("bundled/inbox/InboxPage");
  expect(warn).not.toHaveBeenCalled();
});

test("unavailable Git leaves compiled host usable but rejects building attachable artifacts", async () => {
  vi.doMock("node:child_process", async (original) => ({
    ...(await original()),
    execFileSync: () => {
      throw new Error("Git unavailable");
    },
  }));
  try {
    vi.resetModules();
    const source = await import("./plugin-dev.mjs");
    const warn = vi.fn();
    const generated = await source
      .bundledHostPlugin(checkout)
      .load.call({ warn }, "\0virtual:buzz-plugin-host");
    expect(generated).toContain('"buzz.inbox":null');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("compatibility unavailable"),
    );
    await expect(
      source.buildBundledDev({
        plugin: "inbox",
        directory: checkout,
        out: join(directory, "without-git"),
      }),
    ).rejects.toThrow("Git unavailable");
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});
