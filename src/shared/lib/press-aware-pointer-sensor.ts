import { PointerSensor, type PointerSensorOptions } from "@dnd-kit/core";
import type { PointerEvent } from "react";

/**
 * A PointerSensor that refuses a `pointerdown` reporting no button held.
 *
 * dnd-kit starts a drag from pointer travel alone and never re-reads the
 * buttons, so a release the page does not receive leaves it armed: the next
 * move starts a drag nobody asked for, and dnd-kit's capture-phase click
 * blocker swallows the click that move belonged to. The macOS webview does
 * this with tap-to-click, reporting `pointerdown` with `buttons: 0` and
 * deferring the `pointerup`; a deliberate press reports a held button.
 *
 * dnd-kit only creates a sensor when the activator returns `true`, so declining
 * here leaves nothing to unwind. The base handler still applies its
 * primary-button checks and fires `onActivation`.
 */
export class PressAwarePointerSensor extends PointerSensor {
  static override activators = PointerSensor.activators.map(
    ({ eventName, handler }) => ({
      eventName,
      handler: (event: PointerEvent, options: PointerSensorOptions) =>
        event.nativeEvent.buttons !== 0 && handler(event, options),
    }),
  );
}
