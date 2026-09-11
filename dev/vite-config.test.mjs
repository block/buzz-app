import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads the broker's Vite config without native-compatibility warnings", () => {
  // A fresh Node process exercises real config imports, not Vitest's resolver.
  // Loading config creates the plugin but never invokes configureServer, so it
  // cannot read the Keychain, open a server, or contact a relay.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
          import assert from 'node:assert/strict';
          import { loadConfigFromFile } from 'vite';
          const loaded = await loadConfigFromFile(
            { command: 'serve', mode: 'development' },
          );
          assert(loaded?.config.plugins.some(p => p?.name === 'buzz-relay-broker'));
          assert.equal(loaded.config.define['import.meta.env.VITE_BUZZ_LIVE'], '"1"');
        `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        // Keep local Buzz credentials out of the config subprocess.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("BUZZ_"),
          ),
        ),
        BUZZ_DEV_VIEWER: "a".repeat(64),
        BUZZ_RELAY_URL: "",
        BUZZ_COMMUNITY_ALIASES: "",
        VITE_CONFIG_NATIVE_IGNORE_WARNING: "",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("configLoader: 'native'");
}, 15_000);
