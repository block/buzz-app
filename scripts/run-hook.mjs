import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [event, upstream, ...args] = process.argv.slice(2);
if (!["pre-commit", "pre-push"].includes(event) || !upstream)
  throw new Error("Expected a Buzz hook event and upstream hook path.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  PATH: `${resolve(root, "bin")}:${process.env.PATH ?? ""}`,
};
// A missing Lefthook must not send lhm down its adapter fallback path.
for (const file of [resolve(root, "bin/lefthook"), upstream])
  accessSync(file, constants.X_OK);
const input = event === "pre-push" ? readFileSync(0) : undefined;
const buzz = resolve(root, ".githooks", event);
for (const hook of event === "pre-commit"
  ? [buzz, upstream]
  : [upstream, buzz]) {
  const result = await new Promise((done) => {
    const child = spawn(hook, args, {
      env,
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    let interrupted;
    const forward = (signal) => {
      interrupted = signal;
      child.kill(signal);
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.on("error", (error) => console.error(error.message));
    child.on("close", (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      done({ code, signal: interrupted ?? signal });
    });
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") console.error(error.message);
      });
      child.stdin.end(input);
    }
  });
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.code !== 0) process.exit(result.code ?? 1);
}
