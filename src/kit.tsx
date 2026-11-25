// The few controls the canvas needs. Buttons, inputs and menus are the host's
// own where it offers them, and plain elements elsewhere.
import {
  createElement,
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { styles } from "./styles";

type HostUi = {
  Button?: unknown;
  Input?: unknown;
  Menu?: unknown;
};
let ui: HostUi | undefined;
export const useHostUi = (next: HostUi | undefined) => {
  ui = next;
};
// biome-ignore lint/suspicious/noExplicitAny: host components are untyped here.
const Host = (component: unknown) => component as any;

export function Button({
  variant = "outline",
  children,
  ...props
}: {
  variant?: "outline" | "prominent" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  /** Shown as a tooltip. */
  title?: string;
  "aria-label"?: string;
  children?: ReactNode;
}) {
  if (ui?.Button) {
    const HostButton = Host(ui.Button);
    return (
      <HostButton
        {...props}
        size="sm"
        variant={variant === "outline" ? "subtle" : variant}
      >
        {children}
      </HostButton>
    );
  }
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

export function Input({
  value,
  onValueChange,
  invalid,
  ...props
}: {
  value: string;
  onValueChange(value: string): void;
  invalid?: boolean;
  placeholder?: string;
  "aria-label": string;
}) {
  if (ui?.Input) {
    const HostInput = Host(ui.Input);
    return <HostInput {...props} value={value} onValueChange={onValueChange} />;
  }
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    />
  );
}

/** A "+" that offers each choice. */
export function AddMenu({
  label,
  items,
}: {
  label: string;
  items: readonly { label: string; onSelect(): void }[];
}) {
  const [open, setOpen] = useState(false);
  if (ui?.Menu) {
    const HostMenu = Host(ui.Menu);
    return (
      <HostMenu
        aria-label={label}
        icon={<PlusIcon />}
        align="end"
        items={items}
      />
    );
  }
  return (
    <>
      <Button
        variant="ghost"
        aria-label={label}
        onClick={() => setOpen((was: boolean) => !was)}
      >
        +
      </Button>
      {open && (
        <div role="menu" aria-label={label} className={styles.actions}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.emptyState}>
      <h3>{title}</h3>
      <p className={styles.hint}>{description}</p>
      {action}
    </div>
  );
}

/** An icon from the host's own set (Tabler, MIT), drawn as the host draws
 * them: the same grid, stroke and size, in the colour of the text around. */
const icon = (paths: readonly string[]) => () => (
  <svg
    width="1rem"
    height="1rem"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="tabler-icon"
    aria-hidden="true"
  >
    {paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);
/** An artboard: a frame with crop marks. */
export const CanvasIcon = icon([
  "M8 9a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1l0 -6",
  "M3 8l1 0",
  "M3 16l1 0",
  "M8 3l0 1",
  "M16 3l0 1",
  "M20 8l1 0",
  "M20 16l1 0",
  "M8 20l0 1",
  "M16 20l0 1",
]);
export const WheelIcon = icon([
  "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
  "M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
  "M12 14l0 7",
  "M10 12l-6.75 -2",
  "M14 12l6.75 -2",
]);
export const EyeIcon = icon([
  "M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0",
  "M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6",
]);
const PlusIcon = icon(["M12 5l0 14", "M5 12l14 0"]);

/** A button that is only an icon. The host's plugin Button has no such form,
 * so this marks it as one of the host's own icon buttons, which gives it
 * their size, spacing and colour wherever it sits. */
export function IconButton({
  label,
  title,
  selected,
  expanded,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  /** Filled, as the host shows a toggle that is on. */
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const button = wrap.current?.querySelector("button");
    if (!button) return;
    button.dataset.iconVariant = "ghost";
    button.dataset.iconSize = "toolbar";
    button.dataset.iconShape = "control";
    if (selected) button.dataset.selected = "";
    else delete button.dataset.selected;
    if (expanded === undefined) button.removeAttribute("aria-expanded");
    else button.setAttribute("aria-expanded", String(expanded));
  });
  return (
    <span ref={wrap} className={styles.iconButton}>
      <Button
        variant="ghost"
        aria-label={label}
        title={title ?? label}
        disabled={disabled ?? false}
        onClick={onClick}
      >
        {children}
      </Button>
    </span>
  );
}
