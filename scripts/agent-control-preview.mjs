// Attended launch only. --prepare-only writes disposable sample data, launches nothing.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "buzz-agent-editor-"));
const agents = join(directory, "agents");
await mkdir(agents, { mode: 0o700 });
const pubkey = "ab".repeat(32);
const relayUrl = "wss://relay.example";
const id = `${pubkey}-${createHash("sha256").update(relayUrl).digest("hex")}`;
await writeFile(
  join(agents, "agents.json"),
  JSON.stringify(
    {
      version: 1,
      agents: [
        {
          id,
          pubkey,
          relayUrl,
          name: "Sample agent (not runnable)",
          systemPrompt:
            "Edit this sample prompt and save. This identity has no private key.",
          workspace: directory,
          harness: {
            command: "buzz-agent",
            args: [],
            model: "sample-model",
            provider: "databricks_v2",
          },
          environment: { SAMPLE_VALUE: "write-only-example" },
          revision: 1,
          // Synthetic enabled intent exercises Stop; native launch remains gated.
          enabled: true,
          credentialId: "sample-no-key",
          authTag: null,
          imported: {},
        },
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const config = join(directory, "tauri-preview.json");
await writeFile(
  config,
  JSON.stringify({
    identifier: "dev.local.buzz.foundation.agent-editor-preview",
    productName: "Buzz Agent Editor Preview",
    build: {
      beforeDevCommand:
        "pnpm exec vite --config dev/agent-control-preview.vite.mjs",
      devUrl: "http://127.0.0.1:1445",
    },
    app: {
      windows: [
        {
          label: "main",
          title: "Buzz Agent Editor Preview — sample data only",
          width: 1200,
          height: 800,
        },
      ],
    },
  }),
  { mode: 0o600 },
);
console.log(`Disposable native settings: ${agents}`);
console.log(
  "Safe: edit/save the sample and reload to verify persistence. Stop disables its synthetic enabled intent.",
);
console.log(
  "Start/Restart and identity credential import are disabled. No live relay, Keychain or agent launch. Databricks Connect is optional and may open a browser only after your click.",
);
console.log(
  "Preview selected library is read-only but reads your chosen old library; skip it to keep this test wholly synthetic.",
);
console.log(
  "Databricks credentials, if you explicitly connect, persist only under this temporary settings directory. Disconnect removes this app/workspace cache, not browser/provider sessions. Delete the directory yourself when finished.",
);
if (!process.argv.includes("--prepare-only")) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(BUZZ_|BUZZODZ_|NOSTR_|VITE_|DATABRICKS_)/.test(key),
    ),
  );
  env.BUZZ_AGENT_CONTROL_HOME = agents;
  env.BUZZ_AGENT_CONTROL_PREVIEW = "1";
  env.BUZZODZ_HOME = join(directory, "plugins");
  env.BUZZODZ_PROFILE = "agent-preview";
  const child = spawn(
    join(root, "bin/pnpm"),
    ["exec", "tauri", "dev", "--no-watch", "--config", config],
    { cwd: root, env, stdio: "inherit" },
  );
  child.on("error", () => {
    console.error("Could not start the desktop preview.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
