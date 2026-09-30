import { createContext } from "react";

/** Coordinates a reaction glyph's playback with its enclosing celebration. */
export const ReactionAnimation = createContext<{
  celebrate: boolean;
  start(duration: number): void;
} | null>(null);
