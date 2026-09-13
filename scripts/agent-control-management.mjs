// Attended persistent native management only. No old library/key access here.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(BUZZ_|BUZZODZ_|NOSTR_|VITE_|DATABRICKS_)/.test(key),
  ),
);
// Private nonsecret build defaults only; native build.rs validates its allowlist.
if (process.env.BUZZ_BUILD_AGENT_ENV)
  env.BUZZ_BUILD_AGENT_ENV = process.env.BUZZ_BUILD_AGENT_ENV;
const config = {
  build: {
    beforeDevCommand:
      "pnpm exec vite --config dev/agent-control-preview.vite.mjs",
    devUrl: "http://127.0.0.1:1445",
  },
  app: {
    windows: [
      {
        label: "main",
        title: "Buzz Foundation — Agent management",
        width: 1200,
        height: 800,
      },
    ],
  },
};
console.log(
  "Persistent native agent management; no sample data, dotenv or live dev broker.",
);
console.log(
  "Keep old Buzz running until the separate attended switch. Import/Connect require explicit clicks; enabled agents restore on later launches.",
);
console.log(
  "Uses the normal app profile. Quit this app and stop its terminal when finished; no native auto-relaunch.",
);
if (!process.argv.includes("--prepare-only")) {
  const child = spawn(
    join(root, "bin/pnpm"),
    ["exec", "tauri", "dev", "--no-watch", "--config", JSON.stringify(config)],
    { cwd: root, env, stdio: "inherit" },
  );
  child.on("error", () => {
    console.error("Could not start native agent management.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
