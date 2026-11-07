// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  applyDocumentAppearance,
  readDocumentAppearance,
} from "./document-appearance";

it("reads the appearance the main window applied and reproduces it in another document", () => {
  const main = document.createElement("html");
  main.dataset.colorMode = "dark";
  main.dataset.accent = "bee";
  main.dataset.colorLevel = "touch";
  main.style.setProperty("--buzz-text-scale", "1.2");
  const read = readDocumentAppearance(main);
  expect(read).toEqual({
    colorMode: "dark",
    accent: "bee",
    colorLevel: "touch",
    fontScale: 1.2,
  });
  const companion = document.createElement("html");
  applyDocumentAppearance(read, companion);
  expect(companion.dataset.colorMode).toBe("dark");
  expect(companion.classList.contains("dark")).toBe(true);
  expect(companion.dataset.accent).toBe("bee");
  expect(companion.dataset.colorLevel).toBe("touch");
  expect(companion.style.getPropertyValue("--buzz-text-scale")).toBe("1.2");
  // Back to light with defaults: everything the dark pass set is removed.
  applyDocumentAppearance({ colorMode: "light" }, companion);
  expect(companion.dataset.colorMode).toBe("light");
  expect(companion.classList.contains("dark")).toBe(false);
  expect(companion.dataset.accent).toBeUndefined();
  expect(companion.style.getPropertyValue("--buzz-text-scale")).toBe("");
});

it("ignores values that are not appearance tokens", () => {
  const main = document.createElement("html");
  main.dataset.accent = "x".repeat(40);
  main.dataset.colorLevel = "bad value";
  main.style.setProperty("--buzz-text-scale", "99");
  expect(readDocumentAppearance(main)).toEqual({
    colorMode: "light",
    accent: undefined,
    colorLevel: undefined,
  });
  const companion = document.createElement("html");
  applyDocumentAppearance(
    { colorMode: "dark", accent: "<script>", fontScale: 99 },
    companion,
  );
  expect(companion.dataset.accent).toBeUndefined();
  expect(companion.style.getPropertyValue("--buzz-text-scale")).toBe("");
});
