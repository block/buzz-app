/** One quiet capsule per chord; spoken key names remain available to assistive technology. */
export function KeyboardShortcut({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  return (
    <kbd data-buzz-ui="" className="buzz-keyboard-shortcut" data-binding={text}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" dir="ltr">
        {text}
      </span>
    </kbd>
  );
}
