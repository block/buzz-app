// DESIGN PASS PENDING: provisional black-and-white UI; not yet part of the design system.
import type { KeyBinding } from "./bindings";
import { formatBinding } from "./format";
import styles from "./KeyCombo.module.css";

/** A chord as key chips. Nested kbd marks each key inside the chord. */
export function KeyCombo({
  binding,
  apple,
}: {
  binding: KeyBinding;
  apple: boolean;
}) {
  const { parts, text, label } = formatBinding(binding, apple);
  return (
    <kbd
      className={styles.combo}
      data-design-pass="pending"
      data-binding={text}
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className={styles.keys}>
        {parts.map((part) => (
          <kbd key={part} className={`${styles.key} text-mono-sm`}>
            {part}
          </kbd>
        ))}
      </span>
    </kbd>
  );
}
