import { KeyboardShortcut } from "../../shared/design-system/ui/KeyboardShortcut";
import type { KeyBinding } from "./bindings";
import { formatBinding } from "./format";

/** Keep platform formatting with the shortcut owner; shared UI owns the capsule. */
export function KeyCombo({
  binding,
  apple,
}: {
  binding: KeyBinding;
  apple: boolean;
}) {
  const { text, label } = formatBinding(binding, apple);
  return <KeyboardShortcut text={text} label={label} />;
}
