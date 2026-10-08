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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync, transformSync } from "rolldown/utils";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const pluginDirectory = "src/bundled/inbox";
const registry = "__BUZZ_HOST_MODULES__";
const virtualHost = "virtual:buzz-inbox-host";
const cssToken = "__BUZZ_INBOX_DEV_CSS__";

const vitePath = (path) => path.replaceAll("\\", "/");
function inside(directory, path) {
  const child = relative(directory, path);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}
const moduleKey = (directory, path) =>
  vitePath(relative(join(directory, "src"), path)).replace(/\.tsx?$/, "");

async function sourcePath(path) {
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = path + suffix;
    try {
      await readFile(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    }
  }
  throw new Error(`Cannot resolve Inbox import: ${path}`);
}

// Parse emitted JavaScript: type-only imports must never become host dependencies.
export async function inboxDependencies(directory = root) {
  const owned = resolve(directory, pluginDirectory);
  const visited = new Set();
  const modules = new Map();
  async function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    if (!/\.[cm]?[jt]sx?$/.test(path)) return;
    const code = transformSync(path, await readFile(path, "utf8"), {
      jsx: { runtime: "automatic" },
    }).code;
    const parsed = parseSync(path.replace(/\.tsx?$/, ".js"), code);
    if (parsed.errors.length) throw new Error(`Cannot parse ${path}`);
    for (const node of parsed.program.body) {
      if (!node.source) continue;
      const specifier = node.source.value;
      const resolved = specifier.startsWith(".")
        ? await sourcePath(resolve(dirname(path), specifier))
        : specifier;
      if (inside(owned, resolved)) {
        await visit(resolved);
        continue;
      }
      const key = specifier.startsWith(".")
        ? moduleKey(directory, resolved)
        : specifier;
      if (key.startsWith(".."))
        throw new Error(`Import outside src: ${specifier}`);
      const entry = modules.get(key) ?? { path: resolved, names: new Set() };
      for (const item of node.specifiers ?? []) {
        entry.names.add(
          item.type === "ImportNamespaceSpecifier" ||
            node.type === "ExportAllDeclaration"
            ? "*"
            : item.type === "ImportDefaultSpecifier"
              ? "default"
              : (item.imported?.name ??
                item.imported?.value ??
                item.local.name),
        );
      }
      modules.set(key, entry);
    }
  }
  await visit(await sourcePath(join(owned, "index")));
  // Vite's JSX transform can request this even when the source imports only react.
  for (const key of ["react", "react/jsx-runtime"]) {
    if (!modules.has(key)) modules.set(key, { path: key, names: new Set() });
  }
  for (const name of ["jsx", "jsxs", "Fragment"])
    modules.get("react/jsx-runtime").names.add(name);
  return modules;
}

// Host identity is independent of Inbox-only edits/commits. Hash actual host bytes,
// including uncommitted changes and dependency/build inputs, not a moving git HEAD.
export async function hostBuildId(directory = root) {
  const hash = createHash("sha256");
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
      "vite.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "postcss.config.js",
    ],
    { cwd: directory, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of tracked) {
    if (
      path.startsWith(`${pluginDirectory}/`) ||
      /\.test\.[cm]?[jt]sx?$/.test(path)
    )
      continue;
    hash
      .update(path)
      .update("\0")
      .update(await readFile(join(directory, path)))
      .update("\0");
  }
  return hash.digest("hex");
}

export function inboxHostPlugin(directory = root) {
  return {
    name: "buzz-inbox-host-modules",
    resolveId(id) {
      if (id === virtualHost) return `\0${virtualHost}`;
    },
    async load(id) {
      if (id !== `\0${virtualHost}`) return;
      const modules = await inboxDependencies(directory);
      const imports = [];
      const entries = [];
      let index = 0;
      for (const [key, { path, names }] of modules) {
        const source = isAbsolute(path) ? vitePath(path) : key;
        let value;
        if (names.has("*")) {
          value = `m${index++}`;
          imports.push(`import * as ${value} from ${JSON.stringify(source)};`);
        } else {
          const bindings = [...names].sort().map((name) => {
            const local = `m${index++}`;
            imports.push(
              `import { ${name} as ${local} } from ${JSON.stringify(source)};`,
            );
            return `${JSON.stringify(name)}: ${local}`;
          });
          value = `{ ${bindings.join(", ")} }`;
        }
        entries.push(`${JSON.stringify(key)}: ${value}`);
      }
      let buildId = null;
      try {
        buildId = await hostBuildId(directory);
      } catch (error) {
        this.warn(
          `Inbox Dev compatibility is unavailable; the host will reject development artifacts. ${error.message}`,
        );
      }
      return `${imports.join("\n")}\nglobalThis.${registry} = Object.freeze({ buildId: ${JSON.stringify(buildId)}, modules: Object.freeze({ ${entries.join(",\n")} }) });`;
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

export async function buildInboxDev({
  directory = root,
  out = join(root, "dist-inbox-dev"),
  id = "local.inbox-dev",
  name = "Inbox Dev",
} = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || id.startsWith("buzz."))
    throw new Error(
      "Choose an alternate plugin ID outside the buzz. namespace",
    );
  out = resolve(out);
  if (
    out === resolve(directory) ||
    inside(out, resolve(directory)) ||
    inside(join(resolve(directory), "src"), out) ||
    out === join(resolve(directory), "src")
  )
    throw new Error("Output must not replace the source checkout");
  try {
    const files = await readdir(out);
    if (files.some((file) => !["manifest.json", "plugin.js"].includes(file)))
      throw new Error("Output folder contains files other than a built plugin");
    if (
      files.length &&
      JSON.parse(await readFile(join(out, "manifest.json"), "utf8")).id !== id
    )
      throw new Error("Output folder belongs to a different plugin");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const modules = await inboxDependencies(directory);
  const buildId = await hostBuildId(directory);
  const entry = vitePath(resolve(directory, ".inbox-dev-entry.js"));
  const owned = resolve(directory, pluginDirectory);
  const shimPrefix = "\0buzz-host:";
  const check = `const host = globalThis.${registry}; if (!host || host.buildId !== ${JSON.stringify(buildId)}) throw new Error("Inbox Dev targets a different Buzz host. Build it from the source for your installed app. If host source changed under the dev server, restart the host and rebuild Inbox Dev.");`;
  const result = await build({
    root: directory,
    configFile: false,
    envDir: false,
    logLevel: "warn",
    oxc: { jsx: { development: false } },
    plugins: [
      {
        name: "buzz-inbox-dev-build",
        enforce: "pre",
        async resolveId(source, importer) {
          if (source === entry) return entry;
          if (
            !importer ||
            importer === entry ||
            importer.startsWith(shimPrefix)
          )
            return;
          const path =
            source.startsWith(".") || isAbsolute(source)
              ? await sourcePath(resolve(dirname(importer), source))
              : source;
          if (inside(owned, path)) return;
          const key =
            source.startsWith(".") || isAbsolute(source)
              ? moduleKey(directory, path)
              : source;
          if (!modules.has(key))
            throw new Error(`Unsupported host import: ${source}`);
          return `${shimPrefix}${key}`;
        },
        load(moduleId) {
          if (moduleId === entry)
            return `import * as implementation from ${JSON.stringify(vitePath(join(owned, "index.tsx")))};
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
          const key = moduleId.slice(shimPrefix.length);
          const names = modules.get(key).names;
          if (names.has("*")) {
            // Only React namespaces are supported by this Inbox-first export path.
            // Their exports are known by Node without importing any browser host code.
            if (key !== "react" && key !== "react/jsx-runtime")
              throw new Error(`Unsupported namespace host import: ${key}`);
            return import(key).then((module) =>
              shim(
                key,
                Object.keys(module).filter((name) => name !== "module.exports"),
              ),
            );
          }
          return shim(key, [...names]);
        },
      },
    ],
    build: {
      write: false,
      cssCodeSplit: false,
      minify: false,
      lib: { entry, formats: ["es"], fileName: () => "plugin.js" },
    },
  });
  function shim(key, names) {
    const exports = names
      .map(
        (name, index) =>
          `const v${index} = module[${JSON.stringify(name)}]; export { v${index} as ${name} };`,
      )
      .join("\n");
    return `${check} const module = host.modules[${JSON.stringify(key)}]; if (!module || ${JSON.stringify(names)}.some(name => !(name in module))) throw new Error(${JSON.stringify(`Inbox Dev needs host exports from ${key} that this Buzz does not provide. Rebuild against the installed host.`)});\n${exports}`;
  }
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = output.filter((file) => file.type === "chunk");
  const assets = output.filter((file) => file.type === "asset");
  if (
    chunks.length !== 1 ||
    assets.some((file) => !file.fileName.endsWith(".css"))
  )
    throw new Error(
      `Inbox Dev must contain one module and inline CSS only: ${output.map((file) => file.fileName).join(", ")}`,
    );
  const css = assets.map((file) => String(file.source)).join("\n");
  const code = chunks[0].code.replace(
    JSON.stringify(cssToken),
    JSON.stringify(css),
  );
  if (code.includes(cssToken)) throw new Error("Could not inline Inbox styles");
  // Write a complete staging directory before exposing it to folder Reload.
  await mkdir(dirname(resolve(out)), { recursive: true });
  const temporary = await mkdtemp(`${resolve(out)}.building-`);
  try {
    const manifest = JSON.parse(
      await readFile(join(owned, "manifest.json"), "utf8"),
    );
    await writeFile(
      join(temporary, "manifest.json"),
      `${JSON.stringify({ ...manifest, id, name }, null, 2)}\n`,
    );
    await writeFile(join(temporary, "plugin.js"), code);
    await rm(out, { recursive: true, force: true });
    await rename(temporary, out);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    out,
    buildId,
    bytes: Buffer.byteLength(code),
    modules: [...modules.keys()],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [plugin, out, id] = process.argv.slice(2);
  if (plugin !== "inbox")
    throw new Error(
      "Usage: bin/pnpm plugin:dev inbox [output-folder] [alternate-id]",
    );
  console.log(
    JSON.stringify(
      await buildInboxDev({
        ...(out ? { out: resolve(out) } : {}),
        ...(id ? { id } : {}),
      }),
      null,
      2,
    ),
  );
}
