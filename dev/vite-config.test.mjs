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
          import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
          import { tmpdir } from 'node:os';
          import { join } from 'node:path';
          import { loadConfigFromFile } from 'vite';
          const configFile = join(process.cwd(), 'vite.config.ts');
          // Load the real config with isolated .env files, never personal settings.
          const directory = mkdtempSync(join(tmpdir(), 'buzz-vite-config-'));
          const cwd = process.cwd();
          try {
            process.chdir(directory);
            const loaded = await loadConfigFromFile(
              { command: 'serve', mode: 'development' }, configFile,
            );
            assert(loaded?.config.plugins.some(p => p?.name === 'buzz-relay-broker'));
            assert.equal(loaded.config.define['import.meta.env.VITE_BUZZ_LIVE'], '"1"');
            for (const command of ['serve', 'build']) {
              for (const setting of [undefined, '', '0', '1', 'true', 'invalid']) {
                if (setting === undefined) delete process.env.BUZZ_DEV_NOTIFICATIONS;
                else process.env.BUZZ_DEV_NOTIFICATIONS = setting;
                const result = await loadConfigFromFile(
                  { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
                );
                assert.equal(
                  result.config.define['import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED'],
                  JSON.stringify(command === 'serve' && setting === '0' ? '1' : '0'),
                );
              }
            }
            delete process.env.BUZZ_DEV_NOTIFICATIONS;
            writeFileSync('.env.local', 'BUZZ_DEV_NOTIFICATIONS=0');
            for (const command of ['serve', 'build']) {
              const result = await loadConfigFromFile(
                { command, mode: 'development' }, configFile,
              );
              assert.equal(
                result.config.define['import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED'],
                JSON.stringify(command === 'serve' ? '1' : '0'),
              );
            }
          } finally {
            process.chdir(cwd);
            rmSync(directory, { recursive: true, force: true });
          }
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
