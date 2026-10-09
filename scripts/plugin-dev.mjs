import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { parseSync, transformSync, Visitor } from "rolldown/utils";
import {
  inside,
  moduleKey,
  pluginCatalog,
  pluginGraph,
  root,
  sourcePath,
  vitePath,
} from "./plugin-graph.mjs";

const registry = "__BUZZ_HOST_MODULES__";
const virtualHost = "virtual:buzz-plugin-host";
const cssToken = "__BUZZ_PLUGIN_DEV_CSS__";
const shimPrefix = "\0buzz-host:";
const cssImport = (path) => /\.css(?:\?|$)/.test(path);

async function hostSources(directory) {
  const tracked = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "src",
      "scripts",
      "crates",
      "src-tauri",
      "vite.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "postcss.config.js",
    ],
    { cwd: directory, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (path) =>
        path &&
        !/\.test\.[cm]?[jt]sx?$/.test(path) &&
        !path.endsWith("plugin-ownership-baseline.json"),
    )
    .sort();
  const sources = [];
  for (let start = 0; start < tracked.length; start += 64) {
    sources.push(
      ...(await Promise.all(
        tracked
          .slice(start, start + 64)
          .map(async (path) => [path, await readFile(join(directory, path))]),
      )),
    );
  }
  return sources;
}

function fingerprint(selected, directory, graph, sources) {
  const hash = createHash("sha256");
  hash.update(selected.manifest.id).update("\0");
  // A new host import/export requires a host rebuild even if its source bytes
  // were already present. Validate compatibility before retiring healthy code.
  hash
    .update(
      JSON.stringify(
        [...graph.dependencies(selected)]
          .map(([key, value]) => [key, [...value.names].sort(), value.lazy])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .update("\0");
  for (const [path, bytes] of sources) {
    if (inside(selected.folder, join(directory, path))) continue;
    hash.update(path).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

export async function hostBuildId(plugin, directory = root, graph) {
  graph ??= await pluginGraph(directory);
  const selected = graph.catalog.find(
    (entry) => entry.slug === plugin || entry.manifest.id === plugin,
  );
  if (!selected) throw new Error(`Unknown bundled plugin: ${plugin}`);
  return fingerprint(selected, directory, graph, await hostSources(directory));
}

// Native debug policy also gates attachment. This projection is explicitly
// supplied only by a development host, never selected by dotenv/runtime flags.
export function bundledHostPlugin(directory = root) {
  return {
    name: "buzz-plugin-host-modules",
    resolveId(id) {
      if (id === virtualHost) return `\0${virtualHost}`;
    },
    async load(id) {
      if (id !== `\0${virtualHost}`) return;
      const graph = await pluginGraph(directory);
      const modules = new Map();
      const fingerprints = {};
      // One captured source set per host projection, not 28 filesystem walks.
      // It is local to this build so later source edits cannot reuse stale bytes.
      let sources;
      let unavailable;
      try {
        sources = await hostSources(directory);
      } catch (error) {
        unavailable = error;
      }
      for (const plugin of graph.catalog) {
        if (sources) {
          fingerprints[plugin.manifest.id] = fingerprint(
            plugin,
            directory,
            graph,
            sources,
          );
        } else {
          this.warn(
            `Local plugin compatibility unavailable for ${plugin.manifest.id}: ${unavailable.message}`,
          );
          fingerprints[plugin.manifest.id] = null;
        }
        for (const [key, value] of graph.dependencies(plugin)) {
          if (cssImport(value.path) && value.names.size === 0) continue;
          const entry = modules.get(key) ?? { ...value, names: new Set() };
          for (const name of value.names) entry.names.add(name);
          entry.lazy &&= value.lazy;
          modules.set(key, entry);
        }
      }
      const imports = [];
      const eager = [];
      const lazy = [];
      let index = 0;
      for (const [key, { path, names, lazy: deferred }] of modules) {
        const source = JSON.stringify(isAbsolute(path) ? vitePath(path) : key);
        if (deferred) {
          lazy.push(`${JSON.stringify(key)}: () => import(${source})`);
          continue;
        }
        let value;
        if (names.has("*")) {
          value = `m${index++}`;
          imports.push(`import * as ${value} from ${source};`);
        } else {
          const bindings = [...names].sort().map((name) => {
            const local = `m${index++}`;
            imports.push(`import { ${name} as ${local} } from ${source};`);
            return `${JSON.stringify(name)}: ${local}`;
          });
          value = `{ ${bindings.join(", ")} }`;
        }
        eager.push(`${JSON.stringify(key)}: ${value}`);
      }
      return `${imports.join("\n")}\nglobalThis.${registry} = Object.freeze({ fingerprints: Object.freeze(${JSON.stringify(fingerprints)}), modules: Object.freeze({${eager.join(",\n")}}), lazy: Object.freeze({${lazy.join(",\n")}}) });`;
    },
    transform(code, id) {
      if (
        vitePath(id.split("?")[0]) !==
        vitePath(join(directory, "src/bundled/index.ts"))
      )
        return;
      return `import ${JSON.stringify(virtualHost)};\n${code}`;
    },
  };
}

async function namespaceExports(path, directory) {
  if (path === "react" || path === "react/jsx-runtime") {
    // Node's CJS namespace includes synthetic names from both conditional files
    // (e.g. development-only act). Use actual production values: Vite's built
    // host has that table, and a development host is a compatible superset.
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import runtime from ${JSON.stringify(path)}; console.log(JSON.stringify(["default", ...Object.keys(runtime)]));`,
        ],
        {
          cwd: directory,
          env: { ...process.env, NODE_ENV: "production" },
          encoding: "utf8",
        },
      ),
    );
  }
  // Inspect the build's public export table without evaluating host/browser code.
  const result = await build({
    root: directory,
    configFile: false,
    envDir: false,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: path, formats: ["es"] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  return (Array.isArray(result) ? result[0] : result).output.find(
    (file) => file.type === "chunk" && file.isEntry,
  ).exports;
}

export async function buildBundledDev({ plugin, directory = root, out } = {}) {
  const catalog = await pluginCatalog(directory);
  let selected = catalog.find(
    (entry) => entry.slug === plugin || entry.manifest.id === plugin,
  );
  if (!selected)
    throw new Error(
      `Unknown bundled plugin: ${plugin}. Choose ${catalog.map((entry) => entry.slug).join(", ")}`,
    );
  const id = selected.manifest.id;
  out = resolve(out ?? join(directory, "dist-plugins", selected.slug));
  if (
    out === resolve(directory) ||
    inside(out, resolve(directory)) ||
    inside(join(resolve(directory), "src"), out) ||
    out === join(resolve(directory), "src")
  )
    throw new Error("Output must not replace the source checkout");
  try {
    const files = await readdir(out);
    if (
      files.some(
        (file) =>
          !["manifest.json", "plugin.js", "plugin.dev.json"].includes(file),
      )
    )
      throw new Error("Output folder contains files other than a built plugin");
    if (
      files.length &&
      JSON.parse(await readFile(join(out, "manifest.json"), "utf8")).id !== id
    )
      throw new Error("Output folder belongs to a different plugin");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const graph = await pluginGraph(directory);
  selected = graph.catalog.find((entry) => entry.manifest.id === id);
  const incoming = graph.violations.filter((edge) =>
    edge.split(" -> ")[1].startsWith(`src/bundled/${selected.slug}/`),
  );
  if (incoming.length)
    throw new Error(
      `Plugin-private source is still consumed outside ${id}:\n${incoming.join("\n")}`,
    );
  const modules = graph.dependencies(selected);
  const buildId = await hostBuildId(plugin, directory, graph);
  const entry = vitePath(join(directory, ".bundled-plugin-dev-entry.js"));
  const check = `const host = globalThis.${registry}; if (!host || host.fingerprints[${JSON.stringify(id)}] !== ${JSON.stringify(buildId)}) throw new Error("Local plugin targets a different Buzz development host. Rebuild/restart the host after shared or native changes.");`;
  const exported = new Map();
  for (const [key, value] of modules)
    if (value.names.has("*") && !value.lazy && !cssImport(value.path))
      exported.set(key, await namespaceExports(value.path, directory));
  const result = await build({
    root: directory,
    configFile: false,
    envDir: false,
    publicDir: false,
    logLevel: "warn",
    oxc: { jsx: { development: false } },
    plugins: [
      {
        name: "buzz-bundled-dev-build",
        enforce: "pre",
        async resolveId(source, importer) {
          if (source === entry) return entry;
          if (
            !importer ||
            importer === entry ||
            importer.startsWith(shimPrefix) ||
            importer.includes("/node_modules/")
          ) {
            // Private vendors still use the host React and other explicitly shared imports.
            if (
              importer?.includes("/node_modules/") &&
              modules.has(source) &&
              !cssImport(source)
            )
              return `${shimPrefix}${encodeURIComponent(source)}.js`;
            return;
          }
          const path =
            source.startsWith(".") || isAbsolute(source)
              ? await sourcePath(resolve(dirname(importer), source))
              : source;
          if (inside(selected.folder, path.split("?")[0])) return;
          const key = moduleKey(directory, path);
          if (cssImport(path) && !modules.get(key)?.names.size) return;
          if (!modules.has(key)) {
            const owners = graph.vendorOwners.get(
              source.startsWith("@")
                ? source.split("/").slice(0, 2).join("/")
                : source.split("/")[0],
            );
            if (owners?.size === 1 && owners.has(id)) return;
            throw new Error(`Unsupported host import: ${source}`);
          }
          return `${shimPrefix}${encodeURIComponent(key)}.js`;
        },
        async transform(code, path) {
          if (!inside(selected.folder, path) || !/\.[cm]?[jt]sx?$/.test(path))
            return;
          const emitted = transformSync(path, code, {
            jsx: { runtime: "automatic" },
          }).code;
          const parsed = parseSync(path.replace(/\.tsx?$/, ".js"), emitted);
          const replacements = [];
          const dynamic = [];
          new Visitor({
            ImportExpression(node) {
              dynamic.push(node);
            },
          }).visit(parsed.program);
          for (const node of dynamic) {
            const source = node.source.value;
            const resolved = source.startsWith(".")
              ? await sourcePath(resolve(dirname(path), source))
              : source;
            const key = moduleKey(directory, resolved);
            if (!modules.has(key)) continue;
            const value = modules.get(key);
            const expression = value.lazy
              ? `host.lazy[${JSON.stringify(key)}]()`
              : `Promise.resolve(host.modules[${JSON.stringify(key)}])`;
            replacements.push({
              start: node.start,
              end: node.end,
              code: `(() => { ${check} return ${expression}; })()`,
            });
          }
          if (!replacements.length) return;
          return replacements
            .sort((a, b) => b.start - a.start)
            .reduce(
              (text, item) =>
                text.slice(0, item.start) + item.code + text.slice(item.end),
              emitted,
            );
        },
        load(moduleId) {
          if (moduleId === entry)
            return `import * as implementation from ${JSON.stringify(vitePath(selected.entry))};
export const inject = implementation.inject;
export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.buzzPlugin = ${JSON.stringify(id)};
    style.textContent = ${JSON.stringify(cssToken)};
    document.head.append(style);
    return () => style.remove();
  });
  return implementation.apply(ctx);
}`;
          if (!moduleId.startsWith(shimPrefix)) return;
          const key = decodeURIComponent(moduleId.slice(shimPrefix.length, -3));
          const dependency = modules.get(key);
          if (dependency.lazy)
            throw new Error(
              `Lazy host imports require a deferred host module: ${key}`,
            );
          const names = exported.get(key) ?? [...dependency.names];
          const exports = names
            .map(
              (name, index) =>
                `const v${index} = module[${JSON.stringify(name)}]; export { v${index} as ${name} };`,
            )
            .join("\n");
          return `${check} const module = host.modules[${JSON.stringify(key)}]; if (!module || ${JSON.stringify(names)}.some(name => !(name in module))) throw new Error(${JSON.stringify(`Local plugin needs new host exports from ${key}. Rebuild the host.`)});\n${exports}`;
        },
      },
    ],
    build: {
      write: false,
      cssCodeSplit: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: () => "plugin.js" },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = output.filter((file) => file.type === "chunk");
  const assets = output.filter((file) => file.type === "asset");
  if (
    chunks.length !== 1 ||
    chunks[0].imports.length ||
    chunks[0].dynamicImports.some((path) => path !== chunks[0].fileName) ||
    assets.some((file) => !file.fileName.endsWith(".css"))
  )
    throw new Error(
      `Local plugin must contain one Blob-loadable module and inline CSS/assets: ${JSON.stringify(output.map(({ fileName, imports, dynamicImports }) => ({ fileName, imports, dynamicImports })))}`,
    );
  const utilities = await compile(
    '@reference "./src/shared/styles/globals.css";\n@layer utilities { @tailwind utilities; }',
    { base: directory, onDependency() {} },
  );
  const candidates = new Scanner({
    sources: [
      {
        base: selected.folder,
        pattern: "**/*.{ts,tsx,js,jsx}",
        negated: false,
      },
    ],
  }).scan();
  const css = [
    ...assets.map((file) => String(file.source)),
    optimize(utilities.build(candidates)).code,
  ].join("\n");
  if (!chunks[0].code.includes(JSON.stringify(cssToken)))
    throw new Error("Missing plugin lifecycle CSS marker");
  const code = chunks[0].code.replace(
    JSON.stringify(cssToken),
    JSON.stringify(css),
  );
  if (code.includes(cssToken))
    throw new Error("Could not inline plugin styles");
  await mkdir(dirname(out), { recursive: true });
  const temporary = await mkdtemp(`${out}.building-`);
  try {
    await writeFile(
      join(temporary, "manifest.json"),
      `${JSON.stringify(selected.manifest, null, 2)}\n`,
    );
    await writeFile(
      join(temporary, "plugin.dev.json"),
      `${JSON.stringify({ version: 1, id, hostBuildId: buildId }, null, 2)}\n`,
    );
    await writeFile(join(temporary, "plugin.js"), code);
    await rm(out, { recursive: true, force: true });
    await rename(temporary, out);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    out,
    id,
    buildId,
    bytes: Buffer.byteLength(code),
    modules: [...modules.keys()],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [plugin, out, extra] = process.argv.slice(2);
  if (!plugin || extra)
    throw new Error(
      "Usage: bin/pnpm plugin:dev <catalog-plugin> [output-folder]",
    );
  console.log(
    JSON.stringify(
      await buildBundledDev({ plugin, ...(out ? { out: resolve(out) } : {}) }),
      null,
      2,
    ),
  );
}
