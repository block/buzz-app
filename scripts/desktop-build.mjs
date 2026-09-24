import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { desktopOverlay, isScheme, options } from "./desktop-config.mjs";
import { worktreeScheme } from "./worktree-scheme.mjs";

// A debug bundle carrying this worktree's overlay, for the one thing `just desktop`
// cannot do: macOS routes a URL scheme only to a bundled application, so testing OS
// deep links there needs a bundle registered with Launch Services. Windows and Linux
// development binaries register themselves at every start and need no bundle.
// Release bundling stays a plain `pnpm tauri build`, which registers the committed
// scheme because it passes no overlay.
const args = process.argv.slice(2);
const { values, forwarded, rest } = options(args, ["scheme"]);
if (values.scheme !== undefined && !isScheme(values.scheme)) {
  console.error(
    "--scheme must be a lowercase URL scheme, such as buzz or buzz-dev-3fa9c1.",
  );
  process.exit(1);
}
const help = forwarded.some((arg) => arg === "--help" || arg === "-h");
const root = fileURLToPath(new URL("../", import.meta.url));
const scheme = values.scheme ?? worktreeScheme(root);
// `--bundles app` is the cheapest bundle Launch Services will read; a caller who
// wants another format, or none, says so and keeps that choice.
const chose = forwarded.some(
  (arg) =>
    arg === "--bundles" ||
    arg.startsWith("--bundles=") ||
    arg === "--no-bundle",
);
const defaults = chose ? ["--debug"] : ["--debug", "--bundles", "app"];
if (!help)
  console.log(
    `Bundling with deep links as ${scheme}://${
      values.scheme === undefined
        ? " (derived from the worktree path; pass --scheme to override)"
        : ""
    }`,
  );
// Prepend, as `just desktop` does: Tauri treats everything after a bare positional
// as runner arguments, and a user's own --config must merge after ours to win.
forwarded.unshift("--config", JSON.stringify(desktopOverlay(root, scheme)));
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
