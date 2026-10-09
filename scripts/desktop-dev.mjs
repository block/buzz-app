import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { desktopOverlay, options } from "./desktop-config.mjs";
import { worktreePort } from "./worktree-port.mjs";

const args = process.argv.slice(2);
const { values, forwarded, rest } = options(args, ["port"]);
if (
  values.port !== undefined &&
  (!/^[0-9]+$/.test(values.port) ||
    Number(values.port) < 1 ||
    Number(values.port) > 65535)
) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(1);
}
const port = values.port === undefined ? undefined : Number(values.port);

// Tauri's first positional argument starts implicit runner arguments too.
let release = false;
let runnerArgs = rest.slice(1);
for (let index = 0; index < forwarded.length; index++) {
  const arg = forwarded[index];
  // Short value options may follow boolean flags, e.g. `-vr echo` or `-vf a b`.
  const shortValue = arg.match(/^-[vheV]*([rtcf])(.*)$/);
  if (arg === "--release") release = true;
  else if (
    ["--runner", "--target", "--config", "--additional-watch-folders"].includes(
      arg,
    ) ||
    (shortValue && shortValue[1] !== "f" && !shortValue[2])
  )
    index++;
  else if (
    arg === "--features" ||
    (shortValue?.[1] === "f" && !shortValue[2])
  ) {
    while (
      index + 1 < forwarded.length &&
      !forwarded[index + 1].startsWith("-")
    )
      index++;
  } else if (!arg.startsWith("-")) {
    runnerArgs = [...forwarded.slice(index), ...rest];
    break;
  }
}

// The first `--` starts Cargo arguments; Cargo's own `--` starts app arguments.
// Explicit profiles may disable debug assertions, so use the pinned bundle for
// all of them, including custom profiles whose settings this launcher cannot know.
const appBoundary = runnerArgs.indexOf("--");
release ||= runnerArgs
  .slice(0, appBoundary < 0 ? undefined : appBoundary)
  .some(
    (arg) =>
      arg === "--release" ||
      /^-[vq]*r/.test(arg) ||
      arg === "--profile" ||
      arg.startsWith("--profile="),
  );

const help = forwarded.some((arg) => arg === "--help" || arg === "-h");
// Prepare resources before Tauri can compile or observe an already-running Vite.
// Its dev-server readiness timeout must not include a cold runtime build.
if (!help) {
  const prepared = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./build-agent-runtime.mjs", import.meta.url)),
      ...(release ? [] : ["--dev"]),
    ],
    { stdio: "inherit" },
  );
  if (prepared.error) console.error(prepared.error.message);
  if (prepared.signal) process.kill(process.pid, prepared.signal);
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const config = desktopOverlay(root);
if (!release) {
  config.bundle ??= {};
  // Merge-patch removes the stock lean source. Both modes keep stable paths so
  // preparation in the other mode cannot replace resources read later by Tauri.
  config.bundle.resources = {
    "resources/agent-runtime/": null,
    "resources/agent-runtime-dev/": "agent-runtime/",
  };
}
// Tauri's own --port controls its static-file server, not our Vite server.
// Without --port, each worktree derives its own stable port; vite.config.ts
// derives the same one, so devUrl and Vite's strict port cannot disagree.
const devPort = port ?? worktreePort(root);
config.build = {
  devUrl: `http://localhost:${devPort}`,
  beforeDevCommand: `pnpm dev:desktop --port ${devPort}`,
};
if (!help)
  console.log(
    `Desktop dev server on ${config.build.devUrl}` +
      (port === undefined
        ? " (derived from the worktree path; pass --port to override)"
        : ""),
  );
// Prepend: Tauri treats everything after a bare positional as runner args.
// Explicit user configs merge afterward and retain precedence.
forwarded.unshift("--config", JSON.stringify(config));
// Runner/application arguments after -- belong to Tauri, including any --port.
forwarded.push(...rest);
// Vite normally reads .env.local only in its own process. Give Rust the same
// effective public pin (including an explicit empty override), so native agent
// starts select the signer that the development frontend actually uses.
const viewer =
  loadEnv("development", process.cwd(), "BUZZ_DEV_VIEWER").BUZZ_DEV_VIEWER ??
  "";
const result = spawnSync("pnpm", ["tauri", "dev", ...forwarded], {
  stdio: "inherit",
  env: { ...process.env, BUZZ_DEV_VIEWER: viewer },
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
