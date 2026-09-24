// Build only. Never launches the app, authenticates, or reads an old Buzz library.
import { spawn } from "node:child_process";
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
env.CARGO_TARGET_DIR = join(root, "target/agent-runtime-build");
async function run(command, args, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
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
const target = (await run(join(root, "bin/rustc"), ["-vV"], true)).match(
  /^host: (.+)$/m,
)?.[1];
if (!target) throw new Error("Could not resolve pinned Rust target");
const destination = join(root, "src-tauri/resources/agent-runtime");
const filenames = spec.tools.map((name) =>
  process.platform === "win32" ? `${name}.exe` : name,
);
async function currentBundle() {
  try {
    if (!(await lstat(destination)).isDirectory()) return false;
    const manifestPath = join(destination, "manifest.json");
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
      const path = join(destination, filename);
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
if (await currentBundle()) {
  console.log(`Agent runtime ready (${spec.revision}, ${target})`);
  process.exit(0);
}
console.log(
  "Preparing the agent runtime; the first build can take several minutes.",
);
await mkdir(join(root, "target"), { recursive: true });
const stage = await mkdtemp(join(root, "target/agent-runtime-stage-"));
try {
  // One source revision and one frozen workspace lock, no local path/ambient tools.
  await run(join(root, "bin/cargo"), [
    "install",
    "--git",
    spec.repository,
    "--rev",
    spec.revision,
    "--locked",
    "--root",
    stage,
    "buzz-acp",
    "buzz-agent",
    "buzz-dev-mcp",
    "buzz-cli",
    "git-credential-nostr",
  ]);
  await mkdir(destination, { recursive: true });
  const files = {};
  for (const name of spec.tools) {
    const filename = process.platform === "win32" ? `${name}.exe` : name;
    const source = join(stage, "bin", filename);
    files[filename] = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
    await copyFile(source, join(destination, `${filename}.new`));
    await chmod(join(destination, `${filename}.new`), 0o755);
    await rename(
      join(destination, `${filename}.new`),
      join(destination, filename),
    );
  }
  // Publish manifest last: interrupted staging is detected as mismatched, not ready.
  const manifest = { version: 1, revision: spec.revision, target, files };
  await writeFile(
    join(destination, "manifest.json.new"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rename(
    join(destination, "manifest.json.new"),
    join(destination, "manifest.json"),
  );
  console.log(
    `Verified inputs staged at ${destination} (${spec.revision}, ${target})`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
