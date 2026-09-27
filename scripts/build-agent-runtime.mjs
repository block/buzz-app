// Build only. Never launches the app, authenticates, or reads an old Buzz library.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFile,
  lstat,
  access,
  constants,
  mkdir,
  mkdtemp,
  copyFile,
  chmod,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(
  await readFile(join(root, "runtime/agent-runtime.json"), "utf8"),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(BUZZ_|BUZZODZ_|NOSTR_|DATABRICKS_|CARGO_TARGET_DIR$)/.test(key),
  ),
);
env.PATH = `${join(root, "bin")}:${env.PATH ?? ""}`;
async function run(command, args, capture = false, cwd = root) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? accept(output)
        : reject(new Error(`Runtime build failed (${code})`)),
    );
  });
}
const toolchain = await run(join(root, "bin/rustc"), ["-vV"], true);
const target = toolchain.match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error("Could not resolve pinned Rust target");
const destination = join(root, "src-tauri/resources/agent-runtime");
const filenames = spec.tools.map((name) =>
  process.platform === "win32" ? `${name}.exe` : name,
);
// One source revision and one frozen workspace lock, no local path/ambient tools.
// A single build shares dependency compilation across the five tools.
const packages = [
  "buzz-acp",
  "buzz-agent",
  "buzz-dev-mcp",
  "buzz-cli",
  "git-credential-nostr",
];
const buildArgs = ["build", "--release", "--locked", "--bins"].concat(
  ...packages.map((name) => ["-p", name]),
);
// Worktrees of one clone share finished bundles built from identical inputs.
function cachedBundle() {
  let common;
  try {
    common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
  const key = createHash("sha256")
    .update(JSON.stringify([spec, toolchain, buildArgs]))
    .digest("hex")
    .slice(0, 16);
  return join(common, "buzz-agent-runtime", key);
}
async function verifiedBundle(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const manifestPath = join(directory, "manifest.json");
    const meta = await lstat(manifestPath);
    if (!meta.isFile() || meta.size > 16384) return false;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      Object.keys(manifest).length !== 4 ||
      manifest.version !== 1 ||
      manifest.revision !== spec.revision ||
      manifest.target !== target ||
      Object.keys(manifest.files).length !== filenames.length
    )
      return false;
    for (const filename of filenames) {
      const path = join(directory, filename);
      if (!(await lstat(path)).isFile()) return false;
      await access(path, constants.X_OK);
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      if (manifest.files[filename] !== hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}
// Copy files first and publish the manifest last: an interrupted copy is
// detected as mismatched, not ready. APFS and similar filesystems clone.
async function publish(source, directory) {
  await mkdir(directory, { recursive: true });
  const files = {};
  for (const filename of filenames) {
    const temporary = join(directory, `${filename}.new`);
    await copyFile(
      join(source, filename),
      temporary,
      constants.COPYFILE_FICLONE,
    );
    await chmod(temporary, 0o755);
    files[filename] = createHash("sha256")
      .update(await readFile(temporary))
      .digest("hex");
    await rename(temporary, join(directory, filename));
  }
  const manifest = { version: 1, revision: spec.revision, target, files };
  await writeFile(
    join(directory, "manifest.json.new"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rename(
    join(directory, "manifest.json.new"),
    join(directory, "manifest.json"),
  );
}
if (await verifiedBundle(destination)) {
  console.log(`Agent runtime ready (${spec.revision}, ${target})`);
  process.exit(0);
}
const cache = cachedBundle();
if (cache && (await verifiedBundle(cache))) {
  await publish(cache, destination);
  console.log(
    `Verified inputs restored from ${cache} (${spec.revision}, ${target})`,
  );
  process.exit(0);
}
console.log(
  "Preparing the agent runtime; the first build can take several minutes.",
);
await mkdir(join(root, "target"), { recursive: true });
const stage = await mkdtemp(join(root, "target/agent-runtime-stage-"));
try {
  const source = join(stage, "source");
  await mkdir(source);
  await run("git", ["init", "--quiet"], false, source);
  await run(
    "git",
    ["fetch", "--quiet", "--depth", "1", spec.repository, spec.revision],
    false,
    source,
  );
  await run(
    "git",
    ["checkout", "--quiet", "--detach", spec.revision],
    false,
    source,
  );
  env.CARGO_TARGET_DIR = join(stage, "target");
  await run(join(root, "bin/cargo"), buildArgs, false, source);
  await publish(join(stage, "target/release"), destination);
  console.log(
    `Verified inputs staged at ${destination} (${spec.revision}, ${target})`,
  );
  if (cache) {
    // Publish whole entries by rename; a concurrent build may win the race.
    const entry = `${cache}.${process.pid}.new`;
    await publish(destination, entry);
    await rm(cache, { recursive: true, force: true });
    await rename(entry, cache).catch(() =>
      rm(entry, { recursive: true, force: true }),
    );
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
