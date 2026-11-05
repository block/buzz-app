import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bundledPlugins } from ".";

it("lists every bundled plugin in the desktop's native catalog", () => {
  const native = readFileSync(
    new URL("../../crates/plugin-manager/src/lib.rs", import.meta.url),
    "utf8",
  );
  const manifests = import.meta.glob<{ id: string }>("./*/manifest.json", {
    eager: true,
    import: "default",
  });
  const folders = new Map(
    Object.entries(manifests).map(([path, { id }]) => [id, path.split("/")[1]]),
  );
  for (const { manifest } of bundledPlugins)
    expect(native, manifest.id).toContain(
      `src/bundled/${folders.get(manifest.id)}/manifest.json`,
    );
});

it("keeps built-in conversation features out of the optional catalog", () => {
  const ids = bundledPlugins.map(({ manifest }) => manifest.id);
  expect(ids).not.toContain("buzz.emoji");
  expect(ids).not.toContain("buzz.mentions");
});

it("shares every bundled discovery tag between at least two plugins", () => {
  const plugins = new Map<string, string[]>();
  for (const { manifest } of bundledPlugins)
    for (const tag of manifest.discovery?.tags ?? [])
      plugins.set(tag, [...(plugins.get(tag) ?? []), manifest.id]);
  expect(plugins.size).toBeGreaterThan(0);
  for (const [tag, ids] of plugins) expect(ids.length, tag).toBeGreaterThan(1);
});
