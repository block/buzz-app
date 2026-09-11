import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Setup failures must retain their cause; a timeout/signal is not a compiler
// error, and its stdout/stderr can both be empty (including Hermit bootstrap).
export function run(command, args, cwd = root, timeout = 180000) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout });
  if (result.error || result.status !== 0)
    throw new Error(
      [
        `${command} ${args.join(" ")}`,
        `status=${result.status} signal=${result.signal ?? "none"}`,
        result.error && `${result.error.code}: ${result.error.message}`,
        result.stdout,
        result.stderr,
      ]
        .filter((line) => line != null && line !== false)
        .join("\n"),
      { cause: result.error },
    );
  return result.stdout;
}
