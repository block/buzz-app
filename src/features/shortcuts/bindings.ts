// FOUNDATION: In-app key matching. Local editors handle events before this layer.
export type KeyBinding = Readonly<{
  key: string;
  /** Command on Apple platforms, Control elsewhere. Other modifiers match exactly. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}>;
export type Shortcut = Readonly<{
  id: string;
  title: string;
  binding: KeyBinding | readonly KeyBinding[];
  run: () => void | Promise<void>;
  /** Read current state; false makes this registration ineligible. */
  when?: () => boolean;
  allowInEditable?: boolean;
  allowInModal?: boolean;
  /** Held keys are consumed but run only once unless opted in. */
  repeat?: boolean;
}>;

export function normalizeShortcut(shortcut: Shortcut): Shortcut {
  if (
    !shortcut ||
    typeof shortcut.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(shortcut.id) ||
    typeof shortcut.title !== "string" ||
    !shortcut.title.trim() ||
    typeof shortcut.run !== "function" ||
    (shortcut.when !== undefined && typeof shortcut.when !== "function") ||
    [shortcut.allowInEditable, shortcut.allowInModal, shortcut.repeat].some(
      (value) => value !== undefined && typeof value !== "boolean",
    )
  )
    throw new Error("A shortcut needs an id, title, binding and run function");
  const bindings = Array.isArray(shortcut.binding)
    ? shortcut.binding
    : [shortcut.binding];
  if (
    !bindings.length ||
    bindings.some(
      (binding) =>
        !binding ||
        typeof binding.key !== "string" ||
        !binding.key.trim() ||
        [binding.mod, binding.shift, binding.alt].some(
          (value) => value !== undefined && typeof value !== "boolean",
        ),
    )
  )
    throw new Error("Invalid shortcut binding");
  return Object.freeze({
    ...shortcut,
    binding: Object.freeze(
      bindings.map((binding) => Object.freeze({ ...binding })),
    ),
  });
}

export function matches(
  shortcut: Shortcut,
  event: KeyboardEvent,
  apple: boolean,
) {
  const bindings = Array.isArray(shortcut.binding)
    ? shortcut.binding
    : [shortcut.binding];
  return bindings.some(
    (binding) =>
      binding.key.toLowerCase() === event.key.toLowerCase() &&
      !!binding.mod === (apple ? event.metaKey : event.ctrlKey) &&
      !(apple ? event.ctrlKey : event.metaKey) &&
      !!binding.shift === event.shiftKey &&
      !!binding.alt === event.altKey,
  );
}

export function inEditable(event: KeyboardEvent) {
  // composedPath includes the actual input inside an open Shadow DOM, unlike target.
  return event.composedPath().some((target) => {
    const element = target as HTMLElement;
    return (
      element.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
      element.getAttribute?.("role") === "textbox"
    );
  });
}
