import { describe, expect, it } from "vitest";
import {
  normalizeLocale,
  resolveInitialLocale,
  translationResources,
} from "./service";

describe("application locale resolution", () => {
  it("normalizes supported browser and persisted locale forms", () => {
    expect(normalizeLocale("pt_BR")).toBe("pt-BR");
    expect(normalizeLocale("pt-BR")).toBe("pt-BR");
    expect(normalizeLocale("en-GB")).toBe("en-US");
    expect(normalizeLocale("pt-PT")).toBeUndefined();
    expect(normalizeLocale("es-BR")).toBeUndefined();
  });

  it("prefers a supported saved locale over browser preferences", () => {
    expect(resolveInitialLocale("pt-BR", ["en-US"])).toBe("pt-BR");
    expect(resolveInitialLocale("invalid", ["pt-BR", "en-US"])).toBe("pt-BR");
  });

  it("falls back to English when no supported preference exists", () => {
    expect(resolveInitialLocale(undefined, ["es-ES", "fr-FR"])).toBe("en-US");
  });

  it("keeps every supported catalogue structurally complete", () => {
    const englishKeys = Object.keys(
      translationResources["en-US"].translation,
    ).sort();
    const portugueseKeys = Object.keys(
      translationResources["pt-BR"].translation,
    ).sort();
    expect(portugueseKeys).toEqual(englishKeys);
  });
});
