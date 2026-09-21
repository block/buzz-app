import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const allowed = new Set(["@phosphor-icons/react", "@phosphor-icons/core"]);
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
        !allowed.has(name) &&
        /(?:lucide|tabler|phosphor|heroicons|fortawesome|react-icons|iconify|icons-react)/i.test(
          `${name} ${version}`,
        ),
    )
    .map(
      ([name]) =>
        `Unapproved icon dependency: ${name}. Use Phosphor through shared/design-system/icons.`,
    );
}
export function checkIconGateway(path, source) {
  if (!path.startsWith("src/shared/design-system/icons/")) return [];
  const errors = [];
  for (const match of source.matchAll(
    /(?:from\s*|import\s*)["'](@phosphor-icons\/[^"']+)["']/g,
  )) {
    if (
      !/^@phosphor-icons\/(?:react\/dist\/csr\/[A-Z][A-Za-z0-9]*|core\/assets\/(?:thin|light|regular|bold|fill|duotone)\/[a-z0-9-]+\.svg\?raw)$/.test(
        match[1],
      )
    )
      errors.push(
        `Import individual Phosphor modules/assets, not the full catalog: ${match[1]}`,
      );
  }
  if (/export\s*\*/.test(source))
    errors.push("Use explicit named icon exports, not wildcard exports.");
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
    if (
      path.startsWith("src/shared/design-system/icons/") &&
      /\.tsx?$/.test(path)
    )
      errors.push(
        ...checkIconGateway(path, readFileSync(`${root}${path}`, "utf8")).map(
          (error) => `${path}: ${error}`,
        ),
      );
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Icon dependencies and individual-import gateway checked.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) checkIcons();
