// The few controls the canvas needs. Buttons, inputs and menus are the host's
// own where it offers them, and plain elements elsewhere.
import { createElement, Fragment, useState, type ReactNode } from "react";
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

export function Tabs({
  label,
  value,
  onValueChange,
  items,
  trailing,
}: {
  label: string;
  value: string | undefined;
  onValueChange(value: string): void;
  items: readonly {
    value: string;
    label: string;
    onClose?: (() => void) | undefined;
  }[];
  trailing?: ReactNode;
}) {
  return (
    <div className={styles.tabs}>
      <div role="tablist" aria-label={label} className={styles.tablist}>
        {items.map((item) => (
          <span
            key={item.value}
            className={styles.tab}
            data-selected={item.value === value ? "" : undefined}
          >
            <button
              type="button"
              role="tab"
              aria-selected={item.value === value}
              className={styles.tabButton}
              onClick={() => onValueChange(item.value)}
            >
              {item.label}
            </button>
            {item.onClose && (
              <button
                type="button"
                className={styles.tabClose}
                aria-label={`Close ${item.label}`}
                onClick={item.onClose}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {trailing}
    </div>
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
        icon={<span aria-hidden="true">+</span>}
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
