import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DEEP_LINK_SCHEME } from "../features/navigation/deep-links";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

it("registers single-instance ahead of deep-link in the native builder, with argv forwarding enabled", () => {
  const lib = read("../../src-tauri/src/lib.rs");
  const singleInstance = lib.indexOf(
    ".plugin(tauri_plugin_single_instance::init(",
  );
  const deepLink = lib.indexOf(".plugin(tauri_plugin_deep_link::init())");
  expect(singleInstance).toBeGreaterThan(-1);
  expect(deepLink).toBeGreaterThan(singleInstance);
  expect(lib).toMatch(/deep_links::setup\(app\.handle\(\)\)/);
  const cargo = read("../../src-tauri/Cargo.toml");
  expect(cargo).toMatch(/^tauri-plugin-deep-link = "2"$/m);
  expect(cargo).toMatch(
    /^tauri-plugin-single-instance = \{ version = "2", features = \["deep-link"\] \}$/m,
  );
});

it("declares exactly one OS scheme, agreed by the config, the shell and the webview, and bundles so installers register it", () => {
  // The three declarations cannot be derived from one another at build time, so a
  // change to any one must be mirrored in the other two. This is the only check.
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  expect(config.plugins["deep-link"]).toEqual({
    desktop: { schemes: [DEEP_LINK_SCHEME] },
  });
  const shell = read("../../src-tauri/src/deep_links.rs");
  expect(shell.match(/^const SCHEME: &str = "([^"]+)";$/m)?.[1]).toBe(
    DEEP_LINK_SCHEME,
  );
  // RFC 3986 scheme syntax; anything else registers nowhere and fails silently.
  expect(DEEP_LINK_SCHEME).toMatch(/^[a-z][a-z0-9+.-]*$/);
  expect(config.bundle.active).toBe(true);
});

it("keeps the webview off the plugin's own commands; the shell owns the OS scheme", () => {
  // Rust drains OS URLs into the webview as raw strings through two main-window
  // app commands. No deep-link capability is needed, and none is granted, so the
  // webview cannot register or unregister schemes.
  const capability = JSON.parse(
    read("../../src-tauri/capabilities/default.json"),
  );
  const identifiers = capability.permissions.map((permission) =>
    typeof permission === "string" ? permission : permission.identifier,
  );
  expect(identifiers.filter((id) => id.startsWith("deep-link:"))).toEqual([]);
  expect(identifiers.filter((id) => id.startsWith("core:event:"))).toEqual([]);
});
