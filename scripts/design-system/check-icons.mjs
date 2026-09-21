import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync } from "rolldown/utils";

const root = fileURLToPath(new URL("../../", import.meta.url));
const gateway = "src/shared/design-system/icons/";
const allowed = new Set(["@phosphor-icons/react", "@phosphor-icons/core"]);
// Known icon families, not a security sandbox or a classifier for arbitrary new packages.
const family =
  /lucide|tabler|phosphor|heroicons|fortawesome|react-icons|iconify|iconoir|iconsax|radix-ui\/react-icons|icons-react/i;
const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
export function checkIconManifest(manifest) {
  return [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]
    .flatMap((field) => Object.entries(manifest[field] ?? {}))
    .filter(
      ([name, version]) =>
        (family.test(name) && !allowed.has(name)) ||
        (version.startsWith("npm:") &&
          family.test(version.slice(4)) &&
          !allowed.has(version.slice(4).replace(/@[^@]*$/, ""))),
    )
    .map(
      ([name]) =>
        `Unapproved icon dependency: ${name}. Use Phosphor through shared/design-system/icons.`,
    );
}

// Reuse the build tool's syntax parser so JSX, regexes and template text are
// not mistaken for imports, and expressions inside templates remain visible.
export function checkIconSource(path, source) {
  const parsed = parseSync(path, source);
  if (parsed.errors.length)
    return parsed.errors.map(
      (error) => `Cannot inspect icon imports: ${error.message}`,
    );
  const errors = [];
  const inside = path.startsWith(gateway);
  const literal = (node) =>
    node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (inside && node.type === "ExportAllDeclaration")
      errors.push("Use explicit named icon exports, not wildcard exports.");
    let target;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type)
    )
      target = node.source;
    else if (node.type === "TSExternalModuleReference")
      target = node.expression;
    else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    )
      target = node.arguments[0];
    const specifier = literal(target);
    if (typeof specifier === "string" && family.test(packageName(specifier))) {
      if (!inside || !allowed.has(packageName(specifier)))
        errors.push(`Use shared/design-system/icons instead of ${specifier}.`);
      else if (
        !/^@phosphor-icons\/(?:react\/dist\/csr\/[A-Z][A-Za-z0-9]*|core\/assets\/(?:thin|light|regular|bold|fill|duotone)\/[a-z0-9-]+\.svg\?raw)$/.test(
          specifier,
        )
      )
        errors.push(
          `Import individual Phosphor modules/assets, not the full catalog: ${specifier}`,
        );
    }
    for (const value of Object.values(node))
      if (value && typeof value === "object") visit(value);
  }
  visit(parsed.program);
  return errors;
}
export function checkIcons() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const errors = [];
  for (const path of new Set(paths)) {
    if (!existsSync(`${root}${path}`)) continue;
    if (path === "package.json" || path.endsWith("/package.json"))
      errors.push(
        ...checkIconManifest(
          JSON.parse(readFileSync(`${root}${path}`, "utf8")),
        ).map((error) => `${path}: ${error}`),
      );
    if (/\.[cm]?[jt]sx?$/.test(path))
      errors.push(
        ...checkIconSource(path, readFileSync(`${root}${path}`, "utf8")).map(
          (error) => `${path}: ${error}`,
        ),
      );
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Icon dependencies and source import boundary checked.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) checkIcons();
