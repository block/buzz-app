/** Build isolated macOS development apps; invoke from an activated Hermit shell. */
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = process.cwd();
if (process.platform !== "darwin")
  throw new Error("This local test pair builder targets macOS");
const output = resolve(
  process.argv[2] ?? resolve(root, ".scratch/compute-pair"),
);
mkdirSync(output, { recursive: true });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function replaceExecutable(source, destination) {
  const temporary = `${destination}.new`;
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
}
for (const [role, title, web, api, consolePort] of [
  ["serve", "Buzz Compute Provider", 1451, 19337, 13131],
  ["client", "Buzz Compute Consumer", 1452, 19338, 13132],
]) {
  if (
    process.env.BUZZ_COMPUTE_BUILD_ROLE &&
    process.env.BUZZ_COMPUTE_BUILD_ROLE !== role
  )
    continue;
  const identifier = `dev.local.buzz.compute-test.${role}`;
  const config = {
    identifier,
    productName: title,
    build: { devUrl: `http://localhost:${web}` },
    app: {
      windows: [
        {
          title,
          width: 1200,
          height: 800,
          titleBarStyle: "Overlay",
          hiddenTitle: true,
          trafficLightPosition: { x: 20, y: 26 },
          minWidth: 480,
          minHeight: 400,
        },
      ],
    },
  };
  const result = spawnSync("cargo", ["build", "-p", "buzz-foundation"], {
    cwd: root,
    env: { ...process.env, TAURI_CONFIG: JSON.stringify(config) },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const app = join(output, `${title}.app`),
    contents = join(app, "Contents"),
    mac = join(contents, "MacOS"),
    resources = join(contents, "Resources");
  mkdirSync(mac, { recursive: true });
  mkdirSync(resources, { recursive: true });
  replaceExecutable(
    join(root, "target/debug/buzz-foundation"),
    join(mac, "buzz-foundation"),
  );
  if (role === "client" && process.env.BUZZ_AGENT_RUNTIME_SOURCE) {
    const runtime = join(mac, "agent-runtime");
    mkdirSync(runtime, { recursive: true });
    for (const name of ["buzz-acp", "buzz-agent", "buzz-dev-mcp"]) {
      replaceExecutable(
        join(process.env.BUZZ_AGENT_RUNTIME_SOURCE, name),
        join(runtime, name),
      );
    }
  }
  copyFileSync(
    join(root, "src-tauri/icons/icon.icns"),
    join(resources, "icon.icns"),
  );
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>${title}</string><key>CFBundleDisplayName</key><string>${title}</string><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>launch</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleIconFile</key><string>icon.icns</string><key>NSHighResolutionCapable</key><true/></dict></plist>`,
  );
  // The app bundle has no secret material. Its broker uses the existing authorized Keychain account.
  // Refuse an occupied web port rather than attaching to somebody else's server.
  writeFileSync(
    join(mac, "launch"),
    `#!/bin/zsh
set -eu
cd ${quote(root)}
source bin/activate-hermit
export BUZZODZ_HOME=${quote(join(output, `${role}-plugins`))}
export BUZZ_COMPUTE_ROLE=${quote(role)}
export BUZZ_COMPUTE_API_PORT=${api}
export BUZZ_COMPUTE_CONSOLE_PORT=${consolePort}
if [[ -f ${quote(join(output, "account-env.sh"))} ]]; then
  source ${quote(join(output, "account-env.sh"))}
fi
if /usr/sbin/lsof -nP -iTCP:${web} -sTCP:LISTEN >/dev/null 2>&1; then
  print "Port ${web} is already in use. Close this test app before opening another copy." >&2
  exit 1
fi
node node_modules/vite/bin/vite.js --port ${web} --strictPort >${quote(join(output, `${role}-broker.log`))} 2>&1 &
compute_broker_pid=$!
trap 'kill "$compute_broker_pid" 2>/dev/null || true' EXIT
compute_ready=0
for attempt in {1..100}; do
  if /usr/bin/curl --silent --fail http://localhost:${web}/ >/dev/null; then compute_ready=1; break; fi
  if ! kill -0 "$compute_broker_pid" 2>/dev/null; then exit 1; fi
  sleep 0.1
done
if [[ "$compute_ready" != 1 ]]; then exit 1; fi
${quote(join(mac, "buzz-foundation"))} >${quote(join(output, `${role}-app.log`))} 2>&1
`,
    { mode: 0o755 },
  );
  console.log(`Created ${app}`);
}
