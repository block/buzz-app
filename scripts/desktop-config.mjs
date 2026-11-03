import { createHash } from "node:crypto";
import { worktreeIcon } from "./worktree-icon.mjs";

// Pull `--<name> <value>` and `--<name>=<value>` out of a launcher's arguments.
// Scanning stops at `--`, after which everything belongs to Tauri's runner, and the
// last occurrence wins, as it does for Tauri's own repeated flags. A named option
// with no value yields "", which every caller rejects rather than silently deriving.
export function options(args, names) {
  const values = {};
  const forwarded = [];
  let index = 0;
  for (; index < args.length && args[index] !== "--"; index++) {
    const arg = args[index];
    const name = names.find(
      (candidate) =>
        arg === `--${candidate}` || arg.startsWith(`--${candidate}=`),
    );
    if (name === undefined) forwarded.push(arg);
    else
      values[name] =
        arg === `--${name}`
          ? (args[++index] ?? "")
          : arg.slice(name.length + 3);
  }
  return { values, forwarded, rest: args.slice(index) };
}

// Development launches keep their own app storage, copied once from the
// installed app's, so they never take or block it, but share its Agents folder
// (see `src-tauri/src/sign_out/legacy_identifier.rs`).
const DEV_IDENTIFIER = "xyz.block.buzz.desktop.dev";

export function desktopOverlay(root) {
  const config = { identifier: DEV_IDENTIFIER };
  const icon = worktreeIcon(root);
  if (icon) config.bundle = { icon: [icon] };
  return config;
}

// Each worktree owns one native MCP test instance (docs/native-mcp.md), so
// relaunches keep its app data and its client finds it rather than another
// worktree's. The bridge scans 100 ports up from its base, so bases are 100
// apart, in [20000, 59900]. native_mcp.rs enforces both shapes.
export function nativeMcpInstance(root) {
  const digest = createHash("sha256").update(root, "utf8").digest("hex");
  return {
    identifier: `dev.local.buzz.foundation.nexus-test-${digest.slice(0, 12)}`,
    port: 20000 + Number(BigInt(`0x${digest}`) % 400n) * 100,
  };
}
