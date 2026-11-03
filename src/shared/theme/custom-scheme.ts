import type { CSSProperties } from "react";

export const CUSTOM_SCHEME_KEY = "buzz-custom-color-scheme.v1";

export const CUSTOM_SCHEME_COLORS = [
  "app",
  "panel",
  "inset",
  "popover",
  "text",
  "subtleText",
  "border",
  "accent",
  "accentText",
  "message",
  "ownMessage",
] as const;

export type CustomSchemeColor = (typeof CUSTOM_SCHEME_COLORS)[number];
export type CustomScheme = Readonly<Record<CustomSchemeColor, string>>;

export const DEFAULT_CUSTOM_SCHEME: CustomScheme = {
  app: "#15121f",
  panel: "#211c2f",
  inset: "#181421",
  popover: "#2b253a",
  text: "#f8f4ff",
  subtleText: "#c9bedc",
  border: "#3b334f",
  accent: "#f5c518",
  accentText: "#1f1600",
  message: "#2f2940",
  ownMessage: "#44350f",
};

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1]?.toLowerCase();
  if (!hex) return null;
  if (hex.length === 6) return `#${hex}`;
  return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
}

export function parseCustomScheme(value: unknown): CustomScheme | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const scheme: Partial<Record<CustomSchemeColor, string>> = {};
    for (const color of CUSTOM_SCHEME_COLORS) {
      const normalized = normalizeHexColor(parsed[color]);
      if (!normalized) return null;
      scheme[color] = normalized;
    }
    return scheme as CustomScheme;
  } catch {
    return null;
  }
}

export function serializeCustomScheme(scheme: CustomScheme): string {
  return JSON.stringify(scheme);
}

export function customSchemeStyle(scheme: CustomScheme): CSSProperties {
  return {
    "--custom-scheme-app": scheme.app,
    "--custom-scheme-panel": scheme.panel,
    "--custom-scheme-inset": scheme.inset,
    "--custom-scheme-popover": scheme.popover,
    "--custom-scheme-text": scheme.text,
    "--custom-scheme-subtle-text": scheme.subtleText,
    "--custom-scheme-border": scheme.border,
    "--custom-scheme-accent": scheme.accent,
    "--custom-scheme-accent-text": scheme.accentText,
    "--custom-scheme-message": scheme.message,
    "--custom-scheme-own-message": scheme.ownMessage,
  } as CSSProperties;
}
