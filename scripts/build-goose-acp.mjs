// Builds the goose-acp the app bundles from the pin in runtime/goose-acp.json.
// `--dev` (`just desktop`) uses Cargo's fast dev profile; packaged builds use the
// pin's small one.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pin = JSON.parse(
  readFileSync(join(root, "runtime/goose-acp.json"), "utf8"),
);
const profile = process.argv.includes("--dev") ? pin.devProfile : pin.profile;
const name = process.platform === "win32" ? "goose-acp.exe" : "goose-acp";
// Tauri ships this directory as the app's `bin` resources.
const destination = join(root, "src-tauri/resources/bin");
const binary = join(destination, name);
const stampPath = join(destination, "goose-acp.json");
const stamp = `${JSON.stringify({ revision: pin.revision, features: pin.features, profile }, null, 2)}\n`;

if (existsSync(binary) && read(stampPath) === stamp) {
  console.log(`goose-acp ready (${pin.revision.slice(0, 9)}, ${profile})`);
  process.exit(0);
}
console.log(
  `Building goose-acp (${pin.revision.slice(0, 9)}, ${profile}); the first build takes a few minutes.`,
);
// Hermit pins the toolchain on macOS and Linux; Windows CI selects it with rustup.
const env = { ...process.env };
if (process.platform !== "win32")
  env.PATH = `${join(root, "bin")}${delimiter}${env.PATH ?? ""}`;
// The sources keep one path, so a pin bump recompiles only what changed.
const source = join(root, "target/goose-acp-src");
if (
  !existsSync(join(source, ".git")) ||
  git(["rev-parse", "HEAD"]).trim() !== pin.revision
) {
  mkdirSync(source, { recursive: true });
  git(["init", "--quiet"]);
  git(["fetch", "--quiet", "--depth", "1", pin.repository, pin.revision]);
  git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"]);
}
const target = join(root, "target/goose-acp-build");
run(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "goose",
    "--bin",
    "goose-acp",
    "--profile",
    profile,
    "--no-default-features",
    "--features",
    pin.features,
  ],
  // Link the vendored OpenSSL statically, whatever the shell asks for.
  {
    ...env,
    CARGO_TARGET_DIR: target,
    OPENSSL_STATIC: "1",
    OPENSSL_NO_VENDOR: "0",
  },
);
// Cargo names the dev profile's output directory "debug".
const built = join(target, profile === "dev" ? "debug" : profile, name);
if (process.platform === "darwin") {
  // The app must run on Macs without Homebrew's libraries.
  const libraries = run("otool", ["-L", built]).split("\n").slice(1);
  for (const line of libraries) {
    const library = line.trim().split(" (compatibility version")[0];
    if (
      library &&
      !library.startsWith("/usr/lib/") &&
      !library.startsWith("/System/Library/")
    )
      throw new Error(`goose-acp links ${library}, which Macs do not ship`);
  }
}
// Replace the binary whole, then record what it was built from.
mkdirSync(destination, { recursive: true });
copyFileSync(built, `${binary}.new`);
chmodSync(`${binary}.new`, 0o755);
renameSync(`${binary}.new`, binary);
writeFileSync(stampPath, stamp);
console.log(`goose-acp staged at ${binary}`);

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function git(args) {
  return run("git", args, env, source);
}

function run(command, args, childEnv = env, cwd = source) {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed (${result.status})`);
  return result.stdout;
}
