import { worktreeIcon } from "./worktree-icon.mjs";

// RFC 3986 scheme syntax, lower case, which is also what the native shell admits
// links under. An invalid scheme registers nowhere and then fails silently.
export const isScheme = (value) => /^[a-z][a-z0-9+.-]*$/.test(value);

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

// What a development launch overlays on the committed Tauri config: this worktree's
// icon and its own OS scheme. `tauri.conf.json` declares the release scheme, which
// an installed Buzz also owns, so claiming it locally would make deep links
// untestable; a release build passes no overlay at all. Tauri merges this into the
// config that `tauri-codegen` embeds and the bundler reads, so the shell, the
// Info.plist, the Windows registry entries and the Linux desktop file all follow.
// JSON merge patch replaces arrays outright, so the scheme list is overridden
// rather than extended, and `buzz` is not registered alongside.
export function desktopOverlay(root, scheme) {
  const config = {
    plugins: { "deep-link": { desktop: { schemes: [scheme] } } },
  };
  const icon = worktreeIcon(root);
  if (icon) config.bundle = { icon: [icon] };
  return config;
}
