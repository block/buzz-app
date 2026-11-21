import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  dropVariable,
  launchEnvironment,
  nativeMcpInstance,
} from "./desktop-config.mjs";

it("drops a launcher-owned variable in any letter case", () => {
  // Windows resolves variables without regard to case, so a variant the shell
  // exported would otherwise still reach the app.
  const env = {
    BUZZ_DEV_RELEASE_KEY: "1",
    buzz_dev_release_key: "1",
    Buzz_Dev_Release_Key: "1",
    BUZZ_DEV_RELEASE_KEY_OTHER: "kept",
  };
  dropVariable(env, "BUZZ_DEV_RELEASE_KEY");
  expect(env).toEqual({ BUZZ_DEV_RELEASE_KEY_OTHER: "kept" });
});

it("layers the me settings over .env.local, under the process", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-config-"));
  try {
    writeFileSync(
      join(root, ".env.local"),
      "BUZZ_BUILDERLAB_URL=https://local.example\nBUZZ_RELAY_URL=wss://local.example\nOTHER=1\n",
    );
    const me = join(root, "desktop-me.env");
    writeFileSync(
      me,
      "BUZZ_BUILDERLAB_URL=\nBUZZ_NSEC_BACKUP_NAMESPACE=backup/example\nBUZZ_UPDATER_KEY=x\nSECRET=1\n",
    );
    vi.stubEnv("BUZZ_NSEC_BACKUP_NAMESPACE", "backup/process");
    // Without `me`, the file is never read.
    const plain = launchEnvironment(root);
    expect(plain.BUZZ_BUILDERLAB_URL).toBe("https://local.example");
    const shared = launchEnvironment(root, me);
    expect(shared.BUZZ_BUILDERLAB_URL).toBe("");
    expect(shared.BUZZ_RELAY_URL).toBe("wss://local.example");
    expect(shared.BUZZ_NSEC_BACKUP_NAMESPACE).toBe("backup/process");
    expect(shared).not.toHaveProperty("BUZZ_UPDATER_KEY");
    expect(shared).not.toHaveProperty("SECRET");
    expect(shared).not.toHaveProperty("OTHER");
    // A missing file adds nothing.
    expect(launchEnvironment(root, join(root, "absent")).BUZZ_RELAY_URL).toBe(
      "wss://local.example",
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("gives each worktree one native MCP instance that native_mcp.rs accepts", () => {
  const instance = nativeMcpInstance("/work/a/");
  expect(instance.identifier).toMatch(
    /^dev\.local\.buzz\.foundation\.nexus-test-[0-9a-f]{12}$/,
  );
  // The bridge scans base..base+99; bases 100 apart keep worktrees' scans apart.
  expect(instance.port % 100).toBe(0);
  expect(instance.port).toBeGreaterThanOrEqual(20000);
  expect(instance.port + 99).toBeLessThanOrEqual(65535);
  expect(nativeMcpInstance("/work/a/")).toEqual(instance);
  expect(nativeMcpInstance("/work/b/").identifier).not.toBe(
    instance.identifier,
  );
});
