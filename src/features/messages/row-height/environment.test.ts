import { afterEach, expect, it, vi } from "vitest";
import { environment, guard, wordBreaks } from "./environment";

// Inter's subsets as @fontsource-variable/inter declares them (abridged).
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+2000-206F";
const LATIN_EXT = "U+0100-02BA,U+1E00-1E9F";
const CYRILLIC = "U+0301,U+0400-045F";

function fonts(family: string, ...faces: [string, FontFaceLoadStatus][]) {
  const list = faces.map(([unicodeRange, status]) => {
    const face = {
      family: `"${family}"`,
      style: "normal",
      unicodeRange,
      status,
      load: vi.fn(() => {
        let resolve = () => {};
        const loaded = new Promise<void>((done) => {
          resolve = done;
        });
        release.push(() => {
          face.status = "loaded";
          resolve();
        });
        return loaded;
      }),
    };
    return face;
  });
  const release: (() => void)[] = [];
  vi.stubGlobal("document", { fonts: list });
  return { faces: list, release };
}
// Each case uses its own family: faces are read once per family and epoch.
const font = (family: string) => ({
  font: `normal 400 14px "${family}", system-ui, sans-serif`,
  letterSpacing: -0.035,
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("needs only the subset covering ASCII for ASCII text", () => {
  const { faces } = fonts("Ascii", [LATIN, "loaded"], [LATIN_EXT, "unloaded"]);
  expect(guard("Plain words, 42.", font("Ascii"))).toBe(0);
  expect(faces[1]?.load).not.toHaveBeenCalled();
});

it("waits for each needed subset, loading each face once", async () => {
  const { faces, release } = fonts(
    "Subsets",
    [LATIN, "loaded"],
    [LATIN_EXT, "unloaded"],
    [CYRILLIC, "unloaded"],
  );
  const before = environment.snapshot().fonts;
  expect(guard("Łódź", font("Subsets"))).toBeUndefined();
  expect(guard("Łódź again", font("Subsets"))).toBeUndefined();
  expect(faces[1]?.load).toHaveBeenCalledTimes(1);
  expect(faces[2]?.load).not.toHaveBeenCalled();
  release[0]?.();
  await vi.waitFor(() => expect(environment.snapshot().fonts).toBe(before + 1));
  expect(guard("Łódź", font("Subsets"))).toBe(0);
  expect(guard("Привет", font("Subsets"))).toBeUndefined();
  expect(faces[2]?.load).toHaveBeenCalledTimes(1);
});

it("counts a face reporting loaded without its own load", () => {
  const { faces } = fonts("Reported", [LATIN, "loaded"], [CYRILLIC, "loaded"]);
  expect(guard("Привет мир", font("Reported"))).toBe(0);
  expect(faces[1]?.load).not.toHaveBeenCalled();
});

it("guards text in system fallback fonts and refuses CJK punctuation beside other text", () => {
  fonts("Fallback", [LATIN, "loaded"]);
  // Fallback glyphs: the line count must hold across a 2px margin.
  expect(guard("שלום עולם", font("Fallback"))).toBe(2);
  expect(guard("東京、大阪。很好，謝謝！", font("Fallback"))).toBe(2);
  expect(guard("Shipping 🚀 👩‍💻 🇯🇵", font("Fallback"))).toBe(2);
  // Kana is checked against the calibrated sample only once calibrated.
  expect(guard("これは日本語", font("Fallback"))).toBe(2);
  for (const text of [
    "React、Vue",
    "GitHub！で",
    "한국어、한국어",
    "100、200",
    "他说“你好”然后",
    "그는 “안녕하세요”라고",
    "他说——这是真的",
    "中文… 好",
  ])
    expect(guard(text, font("Fallback")), text).toBe("cjk-punctuation");
  // Pretext breaks before small kana; the engines do not.
  for (const text of ["いっしょに", "コンピューター"])
    expect(guard(text, font("Fallback")), text).toBe("kana");
});

it("admits only characters the exactness sweeps verified", () => {
  fonts("Allowed", [LATIN, "loaded"]);
  expect(
    guard(
      "“Curly,” she said — ‘it’s fine’ … ¿qué? 20° × 3 © £5",
      font("Allowed"),
    ),
  ).toBe(0);
  for (const text of [
    "pages 12–48", // en dash
    "well‐known", // hyphen
    "done✅and", // BMP pictograph
    "love❤️you",
    "בית־ספר", // maqaf
    "alpha´beta",
    "Wow‼",
    "½ cup",
    "Ꝺ", // Latin Extended-D
    "ꙮ", // Cyrillic Extended-B
    "བཀྲ་ཤིས", // Tibetan
    "㌔",
    "全角　空白", // ideographic space
    "「你好」他说", // CJK brackets
    "em\u2003space",
    "zero\u200bwidth",
    "lone 🏽 tone",
    "lone 🇯 letter",
    "ǚ", // Latin Extended-B outside Vietnamese and Romanian
    "בֺ", // a Hebrew point beyond common niqqud
  ])
    expect(guard(text, font("Allowed")), text).toBe("characters");
});

it("leaves words to measurement where the engines break them unlike Pretext", () => {
  for (const text of [
    "Hello, world! it’s fine — really… “quoted,” (aside) what?! so...",
    "3.14 at 10:30, 1,000 or $5 (50%) well-known don't",
    "¿qué? ¡sí! «oui»",
    "кто-то сказал «Мир»",
    "привет 🎉 hello",
    "γειά σου, κόσμε.",
    "مرحبا، كيف حالك؟ שלום עולם, מה שלומך?",
    "🎉 20° €5 → 👍🏽 🇯🇵",
  ])
    expect(wordBreaks(text), text).toBeUndefined();
  for (const text of [
    "?gamma",
    "zeta--eta",
    "…alpha",
    "x-50",
    "a/b",
    ":-)",
    "this—that",
    "done!🎉",
    "e.g.",
  ])
    expect(wordBreaks(text), text).toBe("punctuation");
  // Leading punctuation shaped in the previous word's script.
  for (const text of ["привет “Vote”", "ёж ¿Việt", "hello «Мир»"])
    expect(wordBreaks(text), text).toBe("scripts");
  for (const text of ["שלום 10:30.", "مرحبا 12.5,"])
    expect(wordBreaks(text), text).toBe("bidi");
  expect(wordBreaks("他说“你好”")).toBe("cjk-punctuation");
  // The engines break beside some emoji and not others.
  for (const text of ["great🎉job", "word🔗next", "👍🏽ok"])
    expect(wordBreaks(text), text).toBe("emoji");
});
