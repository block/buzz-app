import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { isBuzzLink } from "../features/navigation/buzz-links";

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

it("registers exactly the in-app link scheme with the OS, and bundles so installers claim it", () => {
  // Development, bundled and released apps use the scheme in-app links produce.
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const schemes = config.plugins["deep-link"].desktop.schemes;
  expect(config.plugins["deep-link"]).toEqual({ desktop: { schemes } });
  expect(schemes).toEqual(["buzz"]);
  expect(isBuzzLink(`${schemes[0]}://channel/general`)).toBe(true);
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
