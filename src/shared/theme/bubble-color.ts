import type { CSSProperties } from "react";

// Choices ported from block/buzz's AccentPickerContent.
export const BUBBLE_COLORS = [
  "neutral",
  "blue",
  "cyan",
  "green",
  "orange",
  "red",
  "pink",
  "lilac",
  "purple",
  "indigo",
] as const;
export type BubbleColor = (typeof BUBBLE_COLORS)[number];
export const BUBBLE_COLOR_KEY = "buzz-bubble-color.v1";
export function parseBubbleColor(value: unknown): BubbleColor {
  return BUBBLE_COLORS.includes(value as BubbleColor)
    ? (value as BubbleColor)
    : "neutral";
}

// Scope the existing prominent-button recipe to this message action only.
export const messageButtonStyle = {
  "--affordance-prominent": "var(--surface-message-action)",
  "--affordance-prominent-hover": "var(--surface-message-action)",
  "--affordance-prominent-pressed": "var(--surface-message-action)",
  "--text-inverse": "var(--text-message-action)",
} as CSSProperties;
