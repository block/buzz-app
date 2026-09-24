import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { desktopOverlay, isScheme, options } from "./desktop-config.mjs";

// A debug bundle for the one thing `just desktop` cannot do: macOS routes a URL
// scheme only to a bundled application, so testing OS deep links there needs a
// bundle registered with Launch Services. Windows and Linux development binaries
// register themselves at every start and need no bundle. Like `just desktop`, the
// bundle registers the `buzz` that tauri.conf.json declares unless --scheme names
// another. Release bundling stays a plain `pnpm tauri build`.
const args = process.argv.slice(2);
const { values, forwarded, rest } = options(args, ["scheme"]);
if (values.scheme !== undefined && !isScheme(values.scheme)) {
  console.error("--scheme must be a lowercase URL scheme, such as buzz-dev.");
  process.exit(1);
}
const help = forwarded.some((arg) => arg === "--help" || arg === "-h");
const root = fileURLToPath(new URL("../", import.meta.url));
// `--bundles app` is the cheapest bundle Launch Services will read; a caller who
// wants another format, or none, says so and keeps that choice.
const chose = forwarded.some(
  (arg) =>
    arg === "--bundles" ||
    arg.startsWith("--bundles=") ||
    arg === "--no-bundle",
);
const defaults = chose ? ["--debug"] : ["--debug", "--bundles", "app"];
if (!help && values.scheme !== undefined)
  console.log(`Bundling with deep links as ${values.scheme}://`);
// Prepend, as `just desktop` does: Tauri treats everything after a bare positional
// as runner arguments, and a user's own --config must merge after ours to win. With
// no scheme and no worktree icon there is nothing to overlay, and no --config is
// passed, so the bundle is exactly what `tauri build` would produce on its own.
const overlay = desktopOverlay(root, values.scheme);
if (Object.keys(overlay).length > 0)
  forwarded.unshift("--config", JSON.stringify(overlay));
forwarded.push(...rest);
const result = spawnSync(
  "pnpm",
  ["tauri", "build", ...defaults, ...forwarded],
  {
    stdio: "inherit",
  },
);
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
