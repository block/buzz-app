import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { useId, type ComponentProps, type ReactNode } from "react";
import { CaretDownIcon, CircleNotchIcon, CheckIcon } from "../icons";
import { Field } from "./Field";
import { InputGroup } from "./InputGroup";
import { IconButton } from "./IconButton";
import { Button } from "./Button";

/** Shared presentation; callers retain filtering, custom values and async work. */
function Control({
  label,
  triggerLabel,
  labelVisibility = "visible",
  loading = false,
  onBrowse,
  leading,
  appearance = "field",
  description,
  error,
  id,
  ...props
}: Omit<ComponentProps<typeof BaseCombobox.Input>, "className" | "render"> & {
  label: string;
  labelVisibility?: "visible" | "hidden";
  description?: ReactNode;
  error?: ReactNode;
  triggerLabel: string;
  loading?: boolean;
  onBrowse?: () => void;
  leading?: ReactNode;
  /** `chip` drops the field's surface and browse button until hovered or
   * opened, for a choice that reads as a label. */
  appearance?: "field" | "chip";
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <Field
      label={label}
      labelVisibility={labelVisibility}
      controlId={inputId}
      description={description}
      error={error}
    >
      <BaseCombobox.InputGroup
        render={
          <InputGroup
            data-appearance={appearance === "field" ? undefined : appearance}
            leading={leading}
            trailing={
              <BaseCombobox.Trigger
                tabIndex={0}
                aria-labelledby={undefined}
                aria-label={triggerLabel}
                disabled={props.disabled || props.readOnly}
                onClick={onBrowse}
                render={
                  <IconButton
                    aria-label={triggerLabel}
                    size="sm"
                    icon={
                      loading ? (
                        <CircleNotchIcon
                          size={16}
                          className="motion-safe:animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <CaretDownIcon
                          size={16}
                          className="buzz-dropdown-chevron"
                          aria-hidden="true"
                        />
                      )
                    }
                  />
                }
              />
            }
          />
        }
      >
        <BaseCombobox.Input
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          {...props}
          id={inputId}
          data-buzz-ui=""
          className="buzz-input"
          aria-busy={loading || undefined}
        />
      </BaseCombobox.InputGroup>
    </Field>
  );
}

/** A button-style trigger for comboboxes whose search input lives in the popup.
 * `field` is a labelled form field. `compact` matches Select's compact
 * variant: a small outlined capsule whose label is announced, not shown, for
 * rows of adjacent controls. */
function Trigger({
  label,
  children,
  disabled,
  ...props
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean | undefined;
} & (
  | { variant?: "field"; error?: ReactNode }
  | { variant: "compact"; error?: never }
)) {
  if (props.variant === "compact")
    return (
      <div
        data-buzz-ui=""
        className="buzz-select text-body"
        data-variant="compact"
        data-appearance="outlined"
      >
        <BaseCombobox.Trigger
          aria-label={label}
          disabled={disabled}
          render={(triggerProps) => (
            <Button
              {...triggerProps}
              shape="capsule"
              variant="outline"
              size="sm"
            >
              <span className="buzz-select-value-content">
                <span className="buzz-select-value-text">
                  <span className="buzz-select-value">{children}</span>
                </span>
              </span>
              <span>
                <CaretDownIcon
                  size={14}
                  className="buzz-dropdown-chevron"
                  aria-hidden="true"
                />
              </span>
            </Button>
          )}
        />
      </div>
    );
  return (
    <Field label={label} error={props.error}>
      <BaseCombobox.Trigger
        aria-label={label}
        disabled={disabled}
        data-buzz-ui=""
        className="buzz-input buzz-select-trigger"
      >
        <span className="buzz-select-value">{children}</span>
        <CaretDownIcon
          size={16}
          className="buzz-dropdown-chevron"
          aria-hidden="true"
        />
      </BaseCombobox.Trigger>
    </Field>
  );
}

function Search() {
  return (
    <div className="p-2">
      <BaseCombobox.Input
        aria-label="Search"
        placeholder="Search"
        data-buzz-ui=""
        className="buzz-input"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
      />
    </div>
  );
}

function Popup({
  children,
  empty,
  className = "",
  collisionBoundary,
  side = "bottom",
  collisionAvoidance,
  size = "default",
  search = false,
}: {
  children: ReactNode;
  search?: boolean;
  empty: ReactNode;
  className?: string | undefined;
  /** Compact keeps search visible above a bounded, scrollable result list. */
  size?: "default" | "compact";
  side?: ComponentProps<typeof BaseCombobox.Positioner>["side"];
  collisionAvoidance?: ComponentProps<
    typeof BaseCombobox.Positioner
  >["collisionAvoidance"];
  /** Constrain nested choices to their containing surface; Base UI owns sizing. */
  collisionBoundary?: ComponentProps<
    typeof BaseCombobox.Positioner
  >["collisionBoundary"];
}) {
  return (
    <BaseCombobox.Portal>
      <BaseCombobox.Positioner
        side={side}
        sideOffset={4}
        collisionBoundary={collisionBoundary}
        collisionAvoidance={collisionAvoidance}
        className="buzz-select-positioner"
      >
        <BaseCombobox.Popup
          data-buzz-ui=""
          className={`buzz-select-popup text-body ${className}`}
          data-variant="field"
          data-combobox-size={size}
          initialFocus={search ? true : undefined}
        >
          {search && <Search />}
          <BaseCombobox.Empty className="buzz-combobox-empty">
            {empty}
          </BaseCombobox.Empty>
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

function Item({
  children,
  description,
  ...props
}: Omit<ComponentProps<typeof BaseCombobox.Item>, "className" | "render"> & {
  description?: ReactNode;
}) {
  return (
    <BaseCombobox.Item
      {...props}
      className="buzz-select-option buzz-combobox-option"
    >
      <span className="buzz-combobox-item-content">
        <span>{children}</span>
        {description && (
          <span className="text-body-sm text-subtle">{description}</span>
        )}
      </span>
      <BaseCombobox.ItemIndicator
        className="buzz-combobox-indicator"
        keepMounted
      >
        <CheckIcon size={16} aria-hidden="true" />
      </BaseCombobox.ItemIndicator>
    </BaseCombobox.Item>
  );
}

export const Combobox = {
  Root: BaseCombobox.Root,
  Control,
  Trigger,
  Popup,
  List: BaseCombobox.List,
  Item,
};
