// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  BUZZ_SCHEME,
  type ColorScheme,
  createTerminalThemePreference,
  listSchemes,
  MAX_IMPORTED_SCHEMES,
  parseColorScheme,
  parseAlacrittyScheme,
  resolveTerminalTheme,
  TERMINAL_THEME_KEY,
  xtermTheme,
} from "./theme-preference";

const scheme = (name: string, background = "#101010"): ColorScheme =>
  parseColorScheme({
    name,
    background,
    foreground: "#eeeeee",
    black: "#000",
    red: "#f00",
    green: "#0f0",
    yellow: "#ff0",
    blue: "#00f",
    magenta: "#f0f",
    cyan: "#0ff",
    white: "#fff",
    brightBlack: "#888",
    brightRed: "#f88",
    brightGreen: "#8f8",
    brightYellow: "#ff8",
    brightBlue: "#88f",
    brightMagenta: "#f8f",
    brightCyan: "#8ff",
    brightWhite: "#fff",
  });

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("validates a scheme and maps it to xterm", () => {
  const parsed = scheme(" One Half ");
  expect(parsed.name).toBe("One Half");
  expect(parsed.red).toBe("#ff0000");
  expect(xtermTheme(parsed)).toMatchObject({
    magenta: "#ff00ff",
    brightMagenta: "#ff88ff",
    cursor: "#eeeeee",
    cursorAccent: "#101010",
    selectionBackground: "#eeeeee40",
  });
  expect(xtermTheme(parsed)).not.toHaveProperty("name");
  expect(() => parseColorScheme([])).toThrow("must be an object");
  expect(() => parseColorScheme({ ...parsed, name: "" })).toThrow("name");
  expect(() => parseColorScheme({ ...parsed, red: "red" })).toThrow("“red”");
});

const ALACRITTY = `# Colors (One Half Dark)
[font]
size = 12

[colors.primary]
background = '#282c34'
foreground = "#dcdfe4" # text

[colors.cursor]
text = 'CellBackground'
cursor = '0xa3b3cc'

[colors.normal]
black   = '#282c34'
red     = '#e06c75'
green   = '#98c379'
yellow  = '#e5c07b'
blue    = '#61afef'
magenta = '#c678dd'
cyan    = '#56b6c2'
white   = '#dcdfe4'

[colors.bright]
red = '#ff7a85'

[[colors.indexed_colors]]
index = 16
color = '#ffffff'
`;

it("reads an Alacritty theme, ignoring other settings and filling missing ANSI variants", () => {
  const parsed = parseAlacrittyScheme(" One Half Dark ", ALACRITTY);
  expect(parsed).toMatchObject({
    name: "One Half Dark",
    background: "#282c34",
    foreground: "#dcdfe4",
    cursor: "#a3b3cc",
    magenta: "#c678dd",
    brightRed: "#ff7a85",
    brightMagenta: "#c678dd",
  });
  expect(parsed).not.toHaveProperty("cursorAccent");
  expect(parsed).not.toHaveProperty("color");
  const dotted = parseAlacrittyScheme(
    "Dotted",
    ALACRITTY.replace("[colors.primary]", "[colors]").replace(
      "background = '#282c34'\nforeground",
      "primary.background = '#123456'\nprimary.foreground",
    ),
  );
  expect(dotted.background).toBe("#123456");

  expect(() => parseAlacrittyScheme("", ALACRITTY)).toThrow("name");
  expect(
    parseAlacrittyScheme("Gap", ALACRITTY.replace("red     = '#e06c75'", ""))
      .red,
  ).toBe("#ff7a85");
  expect(() =>
    parseAlacrittyScheme("Gap", ALACRITTY.replace("green   = '#98c379'", "")),
  ).toThrow("“colors.normal.green” is missing");
  expect(() =>
    parseAlacrittyScheme("Bare", ALACRITTY.replace("'#c678dd'", "c678dd")),
  ).toThrow("This isn’t valid TOML: invalid value on line 19.");
  expect(() =>
    parseAlacrittyScheme("Named", ALACRITTY.replace("'#c678dd'", "'purple'")),
  ).toThrow("“colors.normal.magenta” must be a #RGB");
  expect(() => parseAlacrittyScheme("Huge", " ".repeat(64 * 1024 + 1))).toThrow(
    "too large",
  );
});

it("collapses Light/Dark pairs and resolves appearance with a Buzz fallback", () => {
  const light = scheme("Paper Light", "#ffffff");
  const dark = scheme("Paper Dark", "#000000");
  const lone = scheme("Lone Dark");
  const names = listSchemes([lone, dark, light]).map(({ name }) => name);
  expect(names).toEqual([BUZZ_SCHEME, "Selenized", "Lone Dark", "Paper"]);
  expect(
    listSchemes([scheme("Ink light"), scheme("Ink DARK")]).map(
      ({ name }) => name,
    ),
  ).toEqual([BUZZ_SCHEME, "Selenized", "Ink"]);
  const imported = [light, dark];
  const resolve = (
    appearance: "system" | "light" | "dark",
    name: string,
    mode: "light" | "dark",
  ) => resolveTerminalTheme({ appearance, scheme: name, imported }, mode);
  expect(resolve("system", "Paper", "dark").scheme).toBe(dark);
  expect(resolve("system", "Paper", "light").scheme).toBe(light);
  expect(resolve("light", "Paper", "dark").scheme).toBe(light);
  expect(resolve("dark", "Selenized", "light").scheme?.name).toBe(
    "Selenized Dark",
  );
  expect(resolve("dark", "Gone", "light")).toMatchObject({
    entry: { name: BUZZ_SCHEME },
    mode: "dark",
    scheme: null,
  });
});

it("imports, selects, persists and removes schemes, including both of a pair", () => {
  const colors = createTerminalThemePreference();
  colors.setAppearance("dark");
  colors.importScheme(scheme("Paper Light"));
  expect(colors.snapshot().scheme).toBe("Paper Light");
  colors.importScheme(scheme("Paper Dark"));
  expect(colors.snapshot().scheme).toBe("Paper");
  for (const name of ["selenized dark", "Selenized", "Buzz Light"])
    expect(() => colors.importScheme(scheme(name))).toThrow("built-in");

  const restored = createTerminalThemePreference();
  expect(restored.snapshot()).toMatchObject({
    appearance: "dark",
    scheme: "Paper",
    imported: [{ name: "Paper Light" }, { name: "Paper Dark" }],
  });
  restored.remove("Paper");
  expect(restored.snapshot()).toMatchObject({
    scheme: BUZZ_SCHEME,
    imported: [],
  });
  restored.setAppearance("system");
  expect(localStorage.getItem(TERMINAL_THEME_KEY)).toBeNull();
  colors.dispose();
  restored.dispose();
});

it("drops damaged saved imports, caps imports and syncs other windows", () => {
  localStorage.setItem(
    TERMINAL_THEME_KEY,
    JSON.stringify({
      appearance: "sideways",
      scheme: "Kept",
      imported: [scheme("Kept"), { name: "Broken" }, scheme("Buzz")],
    }),
  );
  const colors = createTerminalThemePreference();
  expect(colors.snapshot()).toMatchObject({
    appearance: "system",
    scheme: "Kept",
    imported: [{ name: "Kept" }],
  });
  for (let i = 1; i < MAX_IMPORTED_SCHEMES; i++)
    colors.importScheme(scheme(`Extra ${i}`));
  expect(() => colors.importScheme(scheme("One too many"))).toThrow(
    "Remove one first",
  );
  colors.importScheme(scheme("Kept", "#202020"));
  expect(colors.snapshot().imported).toHaveLength(MAX_IMPORTED_SCHEMES);

  localStorage.setItem(
    TERMINAL_THEME_KEY,
    JSON.stringify({ appearance: "light", scheme: "Selenized", imported: [] }),
  );
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: TERMINAL_THEME_KEY,
      storageArea: localStorage,
    }),
  );
  expect(colors.snapshot()).toMatchObject({
    appearance: "light",
    scheme: "Selenized",
  });
  colors.dispose();
});

it("keeps the active choice when storage fails and retries the save", () => {
  const colors = createTerminalThemePreference();
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("quota");
    });
  colors.setScheme("Selenized");
  expect(colors.snapshot()).toMatchObject({
    scheme: "Selenized",
    error: expect.stringContaining("could not be saved"),
  });
  setItem.mockRestore();
  colors.retry();
  expect(colors.snapshot().error).toBeNull();
  expect(
    JSON.parse(localStorage.getItem(TERMINAL_THEME_KEY) ?? "null"),
  ).toEqual({ appearance: "system", scheme: "Selenized", imported: [] });
  colors.dispose();
});
