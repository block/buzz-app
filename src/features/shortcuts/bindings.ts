// FOUNDATION: In-app key matching. Local editors handle events before this layer.
export type KeyBinding = Readonly<{
  key: string;
  /** Command on Apple platforms, Control elsewhere. Other modifiers match exactly. */
  mod?: boolean;
  /** Control beside Command on Apple platforms. Elsewhere Control is `mod`, so this never matches. */
  ctrl?: boolean;
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
  /** Also run when the topmost modal is its own navigation visit (Settings, Members). */
  allowInVisit?: boolean;
  /** Held keys are consumed but run only once unless opted in. */
  repeat?: boolean;
  /** Lower values appear first within this owner's Settings category; defaults to zero. */
  order?: number;
}>;

/** What the registries hold: aliases are always a frozen array, never a bare binding. */
export type NormalizedShortcut = Shortcut &
  Readonly<{ binding: readonly KeyBinding[]; order: number }>;

export function normalizeShortcut(shortcut: Shortcut): NormalizedShortcut {
  if (
    !shortcut ||
    typeof shortcut.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(shortcut.id) ||
    typeof shortcut.title !== "string" ||
    !shortcut.title.trim() ||
    typeof shortcut.run !== "function" ||
    (shortcut.when !== undefined && typeof shortcut.when !== "function") ||
    [
      shortcut.allowInEditable,
      shortcut.allowInModal,
      shortcut.allowInVisit,
      shortcut.repeat,
    ].some((value) => value !== undefined && typeof value !== "boolean") ||
    (shortcut.order !== undefined && typeof shortcut.order !== "number")
  )
    throw new Error("A shortcut needs an id, title, binding and run function");
  const bindings = Array.isArray(shortcut.binding)
    ? shortcut.binding
    : [shortcut.binding];
  if (!bindings.length || !bindings.every(isKeyBinding))
    throw new Error("Invalid shortcut binding");
  return Object.freeze({
    ...shortcut,
    order: Number.isFinite(shortcut.order) ? (shortcut.order ?? 0) : 0,
    binding: Object.freeze(
      bindings.map((binding) => Object.freeze({ ...binding })),
    ),
  });
}

/** Shape check shared by registration and stored user overrides. */
export function isKeyBinding(value: unknown): value is KeyBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.key === "string" &&
    binding.key.length > 0 &&
    [binding.mod, binding.ctrl, binding.shift, binding.alt].every(
      (flag) => flag === undefined || typeof flag === "boolean",
    )
  );
}

/** Same chord under the dispatcher's rules: case-insensitive key, exact modifiers. */
export function sameBinding(a: KeyBinding, b: KeyBinding) {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    !!a.mod === !!b.mod &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt
  );
}

/** Nonempty list of well-formed bindings: the shape stored overrides must take. */
export function isBindingList(value: unknown): value is readonly KeyBinding[] {
  return Array.isArray(value) && value.length > 0 && value.every(isKeyBinding);
}

/** Callers pass the registered alias array or a stored override; nothing is wrapped here. */
export function matches(
  bindings: readonly KeyBinding[],
  event: KeyboardEvent,
  apple: boolean,
) {
  return bindings.some(
    (binding) =>
      binding.key.toLowerCase() === event.key.toLowerCase() &&
      !!binding.mod === (apple ? event.metaKey : event.ctrlKey) &&
      (apple
        ? !!binding.ctrl === event.ctrlKey
        : !binding.ctrl && !event.metaKey) &&
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

/** One dispatcher action as the resolver sees it, in presentation order. */
export type BindingRow = Readonly<{
  key: string;
  defaults: readonly KeyBinding[];
  /** A field matches it itself; it competes only with other field-local rows. */
  local?: boolean;
  /** A default added after people may have saved its chord elsewhere: it gives
   * way to that saved assignment instead of competing with it. */
  yields?: boolean;
}>;
/** What applies now for one action. `masked` names a saved override that a
 * native chord took over; `restored` says whether its default came back. */
export type ResolvedBinding = Readonly<{
  effective: readonly KeyBinding[];
  masked?: Readonly<{ override: readonly KeyBinding[]; restored: boolean }>;
}>;

const answersTo = (chords: readonly KeyBinding[], binding: KeyBinding) =>
  chords.some((chord) => sameBinding(chord, binding));

/**
 * Effective chords for every action at once, shared by dispatch and Settings.
 * A yielding default (one a newer version added, such as Go to dock's Ctrl+D)
 * is left to a saved override that already uses it, and a yielding action with
 * no default left is unbound. Every other default stays listed as shared, for
 * the person to settle, so resetting an action always brings its default back.
 * A native chord (a menu accelerator that must reach the native menu) masks
 * any saved override equal to it. The masked action gets its default back only
 * if no other action answers to it and it is not native itself; otherwise it
 * is unbound, so the other assignment is kept. Among masked
 * actions sharing a default, the earlier row takes it. Saved preferences are
 * never rewritten here.
 */
export function resolveBindings(
  rows: readonly BindingRow[],
  override: (key: string) => readonly KeyBinding[] | undefined,
  native: readonly KeyBinding[],
): ReadonlyMap<string, ResolvedBinding> {
  const resolved = new Map<string, ResolvedBinding>();
  const masked: { row: BindingRow; override: readonly KeyBinding[] }[] = [];
  const defaulted: BindingRow[] = [];
  // Saved overrides no native chord masks.
  const assignments: BindingRow[] = [];
  for (const row of rows) {
    const saved = override(row.key);
    if (!isBindingList(saved)) {
      if (row.yields) defaulted.push(row);
      else resolved.set(row.key, { effective: row.defaults });
    } else if (!saved.some((binding) => answersTo(native, binding))) {
      resolved.set(row.key, { effective: saved });
      assignments.push(row);
    } else masked.push({ row, override: saved });
  }
  for (const row of defaulted) {
    const assigned = (binding: KeyBinding) =>
      assignments.some(
        (other) =>
          !!other.local === !!row.local &&
          answersTo(resolved.get(other.key)?.effective ?? [], binding),
      );
    const free = row.defaults.filter((binding) => !assigned(binding));
    resolved.set(row.key, {
      effective: free.length === row.defaults.length ? row.defaults : free,
    });
  }
  for (const { row, override: saved } of masked) {
    const taken = (binding: KeyBinding) =>
      answersTo(native, binding) ||
      rows.some(
        (other) =>
          other.key !== row.key &&
          !!other.local === !!row.local &&
          answersTo(resolved.get(other.key)?.effective ?? [], binding),
      );
    const restored = !row.defaults.some(taken);
    resolved.set(row.key, {
      effective: restored ? row.defaults : [],
      masked: { override: saved, restored },
    });
  }
  return resolved;
}
