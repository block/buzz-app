import { devicePreference } from "./device-preference";

/** Device-local choice to glide mouse-wheel notches in channel timelines on
 * Mac WebKit. On by default: it never changes trackpad scrolling, and
 * Reduce motion turns it off. */
export const smoothWheelPreference = devicePreference(
  "buzz-smooth-mouse-wheel.v1",
  "buzz-smooth-mouse-wheel-changed",
  true,
);
