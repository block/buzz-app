import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, transformSync, Visitor } from "rolldown/utils";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const vitePath = (path) => path.replaceAll("\\", "/");
export function inside(directory, path) {
  const child = relative(directory, path);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}
export async function sourcePath(path) {
  const [file, query] = path.split("?", 2);
  for (const suffix of [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    "/index.ts",
    "/index.tsx",
  ]) {
    const candidate = file + suffix;
    try {
      await readFile(candidate);
      return candidate + (query === undefined ? "" : `?${query}`);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    }
  }
  throw new Error(`Cannot resolve plugin source: ${path}`);
}
function program(path, source) {
  const code = transformSync(path, source, {
    jsx: { runtime: "automatic" },
  }).code;
  const parsed = parseSync(path.replace(/\.tsx?$/, ".js"), code);
  if (parsed.errors.length) throw new Error(`Cannot parse ${path}`);
  return parsed.program;
}
const property = (node, name) =>
  node?.properties?.find((item) => item.key?.name === name)?.value;

// Discover the actual catalog, not every manifest directory or an ID prefix.
// Refuse a new catalog shape rather than silently dropping an unsupported entry.
export async function pluginCatalog(directory = root) {
  const path = join(directory, "src/bundled/index.ts");
  const parsed = program(path, await readFile(path, "utf8"));
  const imports = new Map();
  let entries;
  for (const node of parsed.body) {
    if (node.type === "ImportDeclaration") {
      for (const item of node.specifiers)
        imports.set(item.local.name, node.source.value);
    }
    for (const declaration of node.declaration?.declarations ?? []) {
      if (declaration.id.name === "bundledPlugins") entries = declaration.init;
    }
  }
  if (entries?.type !== "ArrayExpression")
    throw new Error("Unsupported bundled plugin catalog");
  const catalog = [];
  const ids = new Set();
  for (const entry of entries.elements) {
    const manifest = property(entry, "manifest");
    const spread = manifest?.properties?.find(
      (item) => item.type === "SpreadElement",
    );
    const manifestImport = imports.get(spread?.argument?.name);
    const moduleImport = imports.get(property(entry, "module")?.name);
    const enabled = property(entry, "enabledByDefault");
    if (
      !manifestImport?.endsWith("/manifest.json") ||
      !moduleImport?.startsWith(".") ||
      enabled?.type !== "Literal" ||
      typeof enabled.value !== "boolean"
    ) {
      throw new Error(
        "Every catalog entry needs a local manifest, module and explicit default",
      );
    }
    const folder = resolve(dirname(path), dirname(manifestImport));
    const module = await sourcePath(resolve(dirname(path), moduleImport));
    if (
      dirname(module) !== folder ||
      !inside(join(directory, "src/bundled"), folder)
    )
      throw new Error("Catalog module must belong to its manifest directory");
    const value = JSON.parse(
      await readFile(join(folder, "manifest.json"), "utf8"),
    );
    if (!value.id || ids.has(value.id))
      throw new Error(`Invalid or duplicate catalog ID: ${value.id}`);
    ids.add(value.id);
    catalog.push({
      slug: relative(join(directory, "src/bundled"), folder),
      folder,
      entry: module,
      manifest: value,
      enabledByDefault: enabled.value,
    });
  }
  return catalog;
}

// Scan emitted JS so type-only references do not create host dependencies.
// Literal lazy imports participate in the same ownership graph as static ones.
async function importsOf(path) {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return [];
  const parsed = program(path, await readFile(path, "utf8"));
  const imports = [];
  for (const node of parsed.body) {
    if (!node.source) continue;
    const names = (node.specifiers ?? []).map((item) =>
      item.type === "ImportNamespaceSpecifier"
        ? "*"
        : item.type === "ImportDefaultSpecifier"
          ? "default"
          : (item.imported?.name ?? item.imported?.value ?? item.local.name),
    );
    if (node.type === "ExportAllDeclaration") names.push("*");
    imports.push({ source: node.source.value, names, lazy: false });
  }
  new Visitor({
    ImportExpression(node) {
      imports.push({
        source: node.source.type === "Literal" ? node.source.value : null,
        names: ["*"],
        lazy: true,
      });
    },
  }).visit(parsed);
  return imports;
}
const packageName = (source) =>
  source.startsWith("@")
    ? source.split("/").slice(0, 2).join("/")
    : source.split("/")[0];
export const moduleKey = (directory, path) =>
  isAbsolute(path)
    ? vitePath(relative(join(directory, "src"), path)).replace(/\.tsx?$/, "")
    : path;

export async function pluginGraph(directory = root) {
  const catalog = await pluginCatalog(directory);
  const nodes = new Map();
  const owner = (path) =>
    catalog.find((plugin) => inside(plugin.folder, path.split("?")[0]));
  async function visit(path) {
    if (nodes.has(path)) return;
    const imports = await importsOf(path);
    nodes.set(path, imports);
    for (const item of imports) {
      if (!item.source) {
        if (owner(path))
          throw new Error(
            `Plugin dynamic imports must be literal: ${relative(directory, path)}`,
          );
        continue;
      }
      item.path = item.source.startsWith(".")
        ? await sourcePath(resolve(dirname(path), item.source))
        : item.source;
      if (isAbsolute(item.path)) await visit(item.path);
    }
  }
  const catalogPath = join(directory, "src/bundled/index.ts");
  await visit(join(directory, "src/main.tsx"));
  for (const plugin of catalog) await visit(plugin.entry);

  function reachable(entry, stop) {
    const found = new Set();
    function walk(path) {
      if (found.has(path) || stop(path)) return;
      found.add(path);
      for (const item of nodes.get(path) ?? []) if (item.path) walk(item.path);
    }
    walk(entry);
    return found;
  }
  // The host imports compiled plugins through the catalog; that edge must not
  // make every private module/vendor a permanent host dependency.
  const host = reachable(
    join(directory, "src/main.tsx"),
    (path) => path === catalogPath,
  );
  const violations = [];
  const vendorOwners = new Map();
  for (const [path, imports] of nodes) {
    if (path === catalogPath) continue;
    for (const item of imports) {
      if (!item.path) continue;
      const targetOwner = owner(item.path);
      const sourceOwner = owner(path);
      if (targetOwner && sourceOwner !== targetOwner)
        violations.push(
          `${vitePath(relative(directory, path))} -> ${vitePath(relative(directory, item.path))}`,
        );
      if (!isAbsolute(item.path)) {
        const key = packageName(item.path);
        const owners = vendorOwners.get(key) ?? new Set();
        owners.add(
          host.has(path) ? "host" : (sourceOwner?.manifest.id ?? "host"),
        );
        vendorOwners.set(key, owners);
      }
    }
  }
  function dependencies(plugin) {
    const modules = new Map();
    const visited = new Set();
    function walk(path) {
      if (visited.has(path)) return;
      visited.add(path);
      for (const item of nodes.get(path) ?? []) {
        if (!item.path) continue;
        const privateSource = owner(item.path) === plugin;
        const owners =
          !isAbsolute(item.path) && vendorOwners.get(packageName(item.path));
        const privateVendor =
          owners && owners.size === 1 && owners.has(plugin.manifest.id);
        if (privateSource || privateVendor) {
          if (privateSource) walk(item.path);
          continue;
        }
        const key = moduleKey(directory, item.path);
        if (key.startsWith(".."))
          throw new Error(`Import outside src: ${item.source}`);
        const entry = modules.get(key) ?? {
          path: item.path,
          names: new Set(),
          lazy: true,
        };
        for (const name of item.names) entry.names.add(name);
        entry.lazy &&= item.lazy;
        modules.set(key, entry);
      }
    }
    walk(plugin.entry);
    // JSX transforms and private vendors must share the running host React.
    for (const key of ["react", "react/jsx-runtime"]) {
      const entry = modules.get(key) ?? {
        path: key,
        names: new Set(),
        lazy: false,
      };
      entry.lazy = false;
      modules.set(key, entry);
    }
    modules.get("react").names.add("*");
    for (const name of ["jsx", "jsxs", "Fragment"])
      modules.get("react/jsx-runtime").names.add(name);
    return modules;
  }
  return {
    catalog,
    nodes,
    host,
    violations: [...new Set(violations)].sort(),
    dependencies,
    vendorOwners,
  };
}
