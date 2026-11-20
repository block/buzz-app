export function scrollAvatarPalette(event: WheelEvent) {
  const surface = event.currentTarget;
  if (!(surface instanceof HTMLElement)) return;
  const dock =
    surface instanceof HTMLFieldSetElement
      ? surface
      : surface.querySelector("fieldset");
  if (!dock || event.ctrlKey) return;
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? dock.clientWidth
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : 1;
  const delta =
    (Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY) * unit;
  const room = dock.scrollWidth - dock.clientWidth;
  if (
    !delta ||
    room <= 0 ||
    (delta < 0 && dock.scrollLeft <= 0) ||
    (delta > 0 && dock.scrollLeft >= room)
  )
    return;
  event.preventDefault();
  dock.scrollBy({ left: delta, behavior: "instant" });
}
