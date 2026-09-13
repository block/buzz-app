import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Exercise the actual pinned ESM bundle that Vite imports, not a copied model.
// Private names are deliberately version-specific: updating Virtua requires
// reviewing/removing the patch and this extraction together.
const source = readFileSync(
  fileURLToPath(import.meta.resolve("virtua")),
  "utf8",
);
const start = source.indexOf("var {min:");
const end = source.indexOf("}, C = e => {");
if (start < 0 || end < 0)
  throw new Error("Review Virtua store extraction after version change");
const helper = source.includes("const isMacWebKit =")
  ? source.slice(source.indexOf("const isMacWebKit ="), start)
  : "";
const core = source.slice(start, end + 1);

function setup(
  platform = "MacIntel",
  vendor = "Apple Computer, Inc.",
  touch = 0,
  agent = "Macintosh",
) {
  const { store, layout } = new Function(
    "navigator",
    `${helper}${core};return {store:y,layout:R};`,
  )({ platform, vendor, maxTouchPoints: touch, userAgent: agent });
  const value = store(layout(20, 100));
  value.W(4, 500); // viewport measurement
  value.W(1, 1300); // real driver scroll observation establishes direction
  return value;
}

it("defers prepend correction on macOS WebKit with matching row/scroll extent", () => {
  const store = setup();
  store.W(5, [40, true]);
  expect(store.L()[0]).toBe(0);
  expect(store.u(39) + store.h(39)).toBe(2000);
  expect(store.t()).toBe(2000);
  store.W(2); // existing observer's scroll-idle boundary, not native acknowledgement
  expect(store.t()).toBe(4000);
  expect(store.u(39) + store.h(39)).toBe(4000);
  expect(store.L()[0]).toBe(2000);
  expect(store.L()[0]).toBe(0); // no duplicate correction
});

it("reversal cannot expose extra trailing extent while compensation is pending", () => {
  const store = setup();
  store.W(5, [40, true]);
  store.W(1, 1500); // reverse to the old bottom
  expect(store.t() - store.o()).toBe(1500);
  expect(store.u(39) + store.h(39)).toBe(store.t());
});

it("positive and negative measured changes preserve row and extent accounting", () => {
  for (const height of [50, 150]) {
    const store = setup();
    store.W(3, [[0, height]]);
    expect(store.L()[0]).toBe(0);
    expect(store.u(19) + store.h(19)).toBe(2000);
    expect(store.t()).toBe(2000);
    store.W(2);
    expect(store.t()).toBe(1900 + height);
    expect(store.L()[0]).toBe(height - 100);
  }
});

it("idle prepend still corrects immediately", () => {
  const store = setup();
  store.W(2);
  store.W(5, [40, true]);
  expect(store.t()).toBe(4000);
  expect(store.L()[0]).toBe(2000);
});

for (const [name, platform, vendor, touch, agent, deferred] of [
  ["macOS Chrome", "MacIntel", "Google Inc.", 0, "Macintosh", false],
  ["macOS Firefox", "MacIntel", "", 0, "Macintosh", false],
  ["Linux WebKit", "Linux x86_64", "Apple Computer, Inc.", 0, "Linux", false],
  [
    "desktop-mode iPad",
    "MacIntel",
    "Apple Computer, Inc.",
    5,
    "Macintosh",
    true,
  ],
  ["iPhone", "iPhone", "Apple Computer, Inc.", 5, "iPhone", true],
]) {
  it(`preserves existing ${name} behavior`, () => {
    const store = setup(platform, vendor, touch, agent);
    store.W(5, [40, true]);
    expect(store.t()).toBe(4000); // no new extent policy outside macOS WebKit
    expect(store.L()[0]).toBe(deferred ? 0 : 2000);
    expect(store.u(39)).toBe(deferred ? 1900 : 3900);
  });
}
