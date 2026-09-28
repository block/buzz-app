import { posix, win32 } from "node:path";

// Hermit owns POSIX tools; Windows CI provisions the same pins through rustup.
export function runtimeBuildPlatform(
  root,
  platform = process.platform,
  inherited = process.env,
) {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !/^(BUZZ_|BUZZODZ_|NOSTR_|DATABRICKS_|CARGO_TARGET_DIR$)/i.test(key),
    ),
  );
  if (!windows) env.PATH = `${path.join(root, "bin")}:${env.PATH ?? ""}`;
  // On Windows preserve the runner's Path spelling. Duplicate PATH/Path keys
  // cause Node to select only one, silently dropping provisioned tools.
  env.CARGO_TARGET_DIR = path.join(root, "target/agent-runtime-build");
  return {
    env,
    cargo: windows ? "cargo.exe" : path.join(root, "bin/cargo"),
    rustc: windows ? "rustc.exe" : path.join(root, "bin/rustc"),
  };
}
